import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = "ghost-writer-judge:local";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_TESTS = 5;
const MAX_TEST_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function executeDocker(args, input, timeout, maxBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer,
        windowsHide: true,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error?.code === "ENOENT") {
          reject(
            new Error(
              "Docker was not found. Install or start Docker Desktop.",
            ),
          );
          return;
        }

        resolve({
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
          timedOut: Boolean(error?.killed),
          outputLimited:
            error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      },
    );

    // A container may exit before consuming all input.
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        reject(error);
      }
    });

    child.stdin.end(input);
  });
}

async function removeContainer(name) {
  const result = await executeDocker(
    ["rm", "--force", name],
    "",
    5000,
    MAX_OUTPUT_BYTES,
  );

  // --rm normally removes the container before this cleanup runs.
  if (
    result.exitCode !== 0 &&
    !result.stderr.includes("No such container")
  ) {
    throw new Error(
      `Could not confirm container cleanup for ${name}: ` +
        result.stderr.trim(),
    );
  }
}

async function runContainer({
  command,
  input,
  timeout,
  maxBuffer,
  executableDirectory,
}) {
  const name = `ghost-writer-judge-${randomUUID()}`;

  const args = [
    "run",
    "--rm",
    "--interactive",
    "--init",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--cpus=1",
    "--memory=256m",
    "--memory-swap=256m",
    "--pids-limit=64",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--user=10001:10001",
    "--ulimit",
    "core=0:0",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777",
  ];

  if (executableDirectory) {
    args.push(
      "--mount",
      `type=bind,source=${executableDirectory},target=/program,readonly`,
    );
  }

  args.push(IMAGE, ...command);

  try {
    return await executeDocker(
      args,
      input,
      timeout,
      maxBuffer,
    );
  } finally {
    // Killing the Docker CLI alone does not reliably stop its container.
    await removeContainer(name);
  }
}

function normalizeOutput(value) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function validateRequest(source, tests) {
  if (
    typeof source !== "string" ||
    source.trim().length === 0 ||
    Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
  ) {
    throw new Error("Source must contain between 1 and 65536 bytes.");
  }

  if (
    !Array.isArray(tests) ||
    tests.length === 0 ||
    tests.length > MAX_TESTS
  ) {
    throw new Error(`Provide between 1 and ${MAX_TESTS} public tests.`);
  }

  const ids = new Set();

  for (const test of tests) {
    if (
      !test ||
      typeof test.id !== "string" ||
      test.id.length === 0 ||
      test.id.length > 100 ||
      ids.has(test.id) ||
      typeof test.input !== "string" ||
      typeof test.expectedOutput !== "string" ||
      Buffer.byteLength(test.input, "utf8") > MAX_TEST_BYTES ||
      Buffer.byteLength(test.expectedOutput, "utf8") > MAX_TEST_BYTES
    ) {
      throw new Error("Invalid public test or duplicate test ID.");
    }

    ids.add(test.id);
  }
}

/**
 * Local public-test preview only.
 *
 * Does not update rooms, official source, objectives, roles, or tokens.
 * The caller supplies trusted public tests.
 */
export async function judgePublicDraft({ source, tests }) {
  validateRequest(source, tests);

  // Source is supplied on stdin, never inserted into a shell command.
  // The shell command itself is fixed.
  const compilation = await runContainer({
    command: [
      "sh",
      "-c",
      [
        "timeout --signal=KILL 12s",
        "g++ -std=c++17 -O0 -pipe",
        "-x c++ -o /tmp/program -",
        "&& base64 /tmp/program",
      ].join(" "),
    ],
    input: source,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (
    compilation.exitCode === 125 ||
    compilation.exitCode === 126 ||
    compilation.exitCode === 127
  ) {
    throw new Error(
      "The compiler container could not run. " +
        compilation.stderr.slice(0, 2000),
    );
  }

  if (
    compilation.exitCode !== 0 ||
    compilation.outputLimited ||
    compilation.timedOut
  ) {
    return {
      status: "COMPILE_ERROR",
      message: compilation.outputLimited
        ? "Compiler output exceeded its limit."
        : compilation.timedOut || compilation.exitCode === 137
          ? "Compilation exceeded its time or resource limit."
          : "The program could not be compiled.",
      compilerOutput: compilation.stderr.slice(0, MAX_OUTPUT_BYTES),
      tests: [],
    };
  }

  const executable = Buffer.from(compilation.stdout, "base64");

  // The Linux executable must start with the ELF signature.
  if (
    executable.length < 4 ||
    !executable.subarray(0, 4).equals(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    )
  ) {
    throw new Error("The compiler did not return a valid executable.");
  }

  // Only the generated executable is placed in this directory.
  // It is never executed on the host.
  const directory = await mkdtemp(
    join(tmpdir(), "ghost-writer-judge-"),
  );

  try {
    await writeFile(join(directory, "program"), executable, {
      mode: 0o755,
    });

    const results = [];

    for (const test of tests) {
      const execution = await runContainer({
        command: [
          "timeout",
          "--signal=KILL",
          "2s",
          "/program/program",
        ],
        input: test.input.endsWith("\n")
          ? test.input
          : `${test.input}\n`,
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        executableDirectory: directory,
      });

      let status;

      if (execution.outputLimited) {
        status = "OUTPUT_LIMIT";
      } else if (execution.timedOut) {
        // This timeout includes Docker startup, not only program execution.
        throw new Error(
          "Docker did not finish the test container in time. Retry the run.",
        );
      } else if (
        execution.exitCode === 124 ||
        execution.exitCode === 137
      ) {
        // Exit 137 can also indicate an out-of-memory kill.
        status = "TIME_OR_RESOURCE_LIMIT";
      } else if (execution.exitCode !== 0) {
        status = "RUNTIME_ERROR";
      } else if (
        normalizeOutput(execution.stdout) ===
        normalizeOutput(test.expectedOutput)
      ) {
        status = "PASSED";
      } else {
        status = "WRONG_ANSWER";
      }

      results.push({
        id: test.id,
        status,
        stdout: execution.stdout,
        stderr: execution.stderr,
        expectedOutput: test.expectedOutput,
      });
    }

    return {
      status: "COMPLETED",
      passed: results.filter((result) => result.status === "PASSED")
        .length,
      total: results.length,
      tests: results,
    };
  } finally {
    // This is the unique temporary directory created by this invocation.
    await rm(directory, { recursive: true, force: true });
  }
}