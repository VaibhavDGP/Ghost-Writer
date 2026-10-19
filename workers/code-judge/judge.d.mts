export interface PublicTest {
  id: string;
  input: string;
  expectedOutput: string;
}

export interface TestResult {
  id: string;
  status:
    | "PASSED"
    | "WRONG_ANSWER"
    | "RUNTIME_ERROR"
    | "TIME_OR_RESOURCE_LIMIT"
    | "OUTPUT_LIMIT";
  stdout: string;
  stderr: string;
  expectedOutput: string;
}

export type JudgeResult =
  | {
      status: "COMPILE_ERROR";
      message: string;
      compilerOutput: string;
      tests: [];
    }
  | {
      status: "COMPLETED";
      passed: number;
      total: number;
      tests: TestResult[];
    };

export function judgePublicDraft(request: {
  source: string;
  tests: PublicTest[];
}): Promise<JudgeResult>;