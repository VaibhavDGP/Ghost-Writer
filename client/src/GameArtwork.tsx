interface Props {
  className?: string;
}

export default function GameArtwork({ className = "" }: Props) {
  return (
    <div className={`game-artwork ${className}`} aria-hidden="true">
      <svg viewBox="0 0 520 340" fill="none">
        {/* Orbital rings */}
        <ellipse
          cx="260"
          cy="184"
          rx="214"
          ry="107"
          transform="rotate(-16 260 184)"
          className="art-orbit"
        />
        <ellipse
          cx="260"
          cy="184"
          rx="178"
          ry="134"
          transform="rotate(28 260 184)"
          className="art-orbit art-orbit-faint"
        />

        {/* Stars */}
        <g className="art-stars">
          <path d="M72 74v16M64 82h16" />
          <path d="M439 65v12M433 71h12" />
          <path d="M431 255v18M422 264h18" />
          <path d="M101 258v10M96 263h10" />
        </g>

        <circle cx="155" cy="49" r="3" fill="#74dbc3" />
        <circle cx="463" cy="177" r="4" fill="#f4bd73" />
        <circle cx="61" cy="198" r="3" fill="#95a9ff" />
        <circle cx="365" cy="301" r="3" fill="#74dbc3" />

        {/* Floating code fragments */}
        <g className="art-code">
          <text x="77" y="157">{"</>"}</text>
          <text x="370" y="120">{"{ }"}</text>
          <text x="155" y="303">{"01"}</text>
        </g>

        {/* Rear ghost */}
        <g transform="translate(343 145) rotate(12)">
          <path
            d="M0 49C0 17 19 0 45 0S90 17 90 49V121L68 108L46 123L23 108L0 121Z"
            fill="#e99775"
            stroke="#172637"
            strokeWidth="6"
            strokeLinejoin="round"
          />
          <path
            d="M24 31Q49 21 77 34V57Q49 69 23 56Z"
            fill="#213c50"
            stroke="#172637"
            strokeWidth="5"
          />
          <path
            d="M33 35Q51 29 66 36"
            stroke="#fff0c9"
            strokeWidth="6"
            strokeLinecap="round"
          />
        </g>

        {/* Main ghost */}
        <g className="art-main-ghost">
          <ellipse
            cx="262"
            cy="295"
            rx="82"
            ry="12"
            fill="#000000"
            opacity=".12"
          />

          <path
            d="M169 160C169 96 204 60 258 60S347 96 347 160V278L304 255L261 283L216 255L169 278Z"
            fill="#70d9bd"
            stroke="#172637"
            strokeWidth="8"
            strokeLinejoin="round"
          />

          <path
            d="M190 157C190 111 216 84 253 81"
            stroke="#baffdf"
            strokeWidth="10"
            strokeLinecap="round"
          />

          <path
            d="M219 112Q268 94 325 118V165Q272 190 219 165Q205 140 219 112Z"
            fill="#234558"
            stroke="#172637"
            strokeWidth="7"
          />

          <path
            d="M234 121Q274 110 309 125"
            stroke="#d8f7ff"
            strokeWidth="11"
            strokeLinecap="round"
          />

          <path
            d="M235 144Q271 135 306 146"
            stroke="#6fa5bd"
            strokeWidth="7"
            strokeLinecap="round"
          />

          <path
            d="M190 206L201 216M319 204L309 214"
            stroke="#238a78"
            strokeWidth="7"
            strokeLinecap="round"
          />
        </g>

        {/* Small floating companion */}
        <g transform="translate(96 186) rotate(-14)">
          <path
            d="M0 34C0 12 13 0 31 0S62 12 62 34V84L47 75L32 85L16 75L0 84Z"
            fill="#9caeff"
            stroke="#172637"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <path
            d="M16 24Q34 16 53 25V41Q34 49 16 40Z"
            fill="#253d58"
            stroke="#172637"
            strokeWidth="4"
          />
          <path
            d="M24 26L44 27"
            stroke="#e9efff"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}