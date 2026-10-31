// Realistic mock data for MemHub

export const promptSuggestions = [
  "What decisions were made in last week's engineering meeting?",
  "Show me our authentication architecture.",
  "What are the current project priorities for Q1?",
  "Summarize the latest customer feedback themes.",
];

export const knowledgeItems = [
  {
    id: "kn_01",
    title: "System Architecture Documentation",
    type: "Technical Docs",
    author: "Aarav K.",
    date: "Feb 08, 2026",
    tags: ["architecture", "backend", "microservices"],
    description: "End-to-end architecture covering services, data flow, deployment topology and failure modes.",
    chunks: 142,
  },
  {
    id: "kn_02",
    title: "Authentication Flow",
    type: "Technical Docs",
    author: "Priya N.",
    date: "Feb 04, 2026",
    tags: ["auth", "jwt", "security"],
    description: "JWT-based auth flow, refresh strategy, session invalidation, and audit logging.",
    chunks: 68,
  },
  {
    id: "kn_03",
    title: "Project Meeting — August 28",
    type: "Meetings",
    author: "Nia R.",
    date: "Aug 28, 2025",
    tags: ["meeting", "planning", "roadmap"],
    description: "Priorities for Q3, blockers on payment migration, and next-quarter product bets.",
    chunks: 24,
  },
  {
    id: "kn_04",
    title: "Product Roadmap 2026",
    type: "Projects",
    author: "Madhav S.",
    date: "Jan 22, 2026",
    tags: ["roadmap", "strategy", "planning"],
    description: "Themes, bets, and quarterly milestones with dependency map across teams.",
    chunks: 96,
  },
  {
    id: "kn_05",
    title: "Recruitment Process Playbook",
    type: "Notes",
    author: "HR Team",
    date: "Dec 12, 2025",
    tags: ["hiring", "playbook", "operations"],
    description: "Sourcing, interview loop, scorecards, and hiring bar calibration guidelines.",
    chunks: 51,
  },
  {
    id: "kn_06",
    title: "API v2 Migration Guide",
    type: "Documents",
    author: "Nia R.",
    date: "Feb 10, 2026",
    tags: ["api", "migration", "backend"],
    description: "Breaking changes, deprecations, migration scripts, and rollback procedure.",
    chunks: 87,
  },
];

export const knowledgeTypes = ["All", "Documents", "Notes", "Meetings", "Projects", "Technical Docs"];

export const documents = [
  { id: "d1", name: "System Architecture.pdf", type: "PDF", uploader: "Aarav K.", date: "Feb 08, 2026", status: "indexed", chunks: 142, size: "2.4 MB" },
  { id: "d2", name: "Authentication Guide.md", type: "MD", uploader: "Priya N.", date: "Feb 04, 2026", status: "indexed", chunks: 68, size: "412 KB" },
  { id: "d3", name: "Product Roadmap.pdf", type: "PDF", uploader: "Madhav S.", date: "Jan 22, 2026", status: "indexed", chunks: 96, size: "3.1 MB" },
  { id: "d4", name: "Engineering Meeting — Aug 28.docx", type: "DOCX", uploader: "Nia R.", date: "Aug 28, 2025", status: "indexed", chunks: 24, size: "168 KB" },
  { id: "d5", name: "API Documentation.md", type: "MD", uploader: "Nia R.", date: "Feb 10, 2026", status: "processing", chunks: 0, size: "820 KB" },
  { id: "d6", name: "Sales Pipeline Q1.csv", type: "CSV", uploader: "Rhea M.", date: "Feb 11, 2026", status: "processing", chunks: 0, size: "1.2 MB" },
  { id: "d7", name: "Compliance Report.pdf", type: "PDF", uploader: "Legal", date: "Feb 06, 2026", status: "failed", chunks: 0, size: "5.6 MB" },
];

export const searchResults = [
  {
    id: "s1",
    title: "Authentication Architecture",
    snippet:
      "JWT tokens are generated after successful authentication using an asymmetric signing key rotated every 90 days. Refresh tokens follow a sliding-window strategy...",
    type: "Technical Docs",
    relevance: 94,
    tags: ["auth", "jwt", "security"],
    source: "Authentication Guide.md",
  },
  {
    id: "s2",
    title: "Session Invalidation Strategy",
    snippet:
      "Sessions can be invalidated at the identity provider layer. A revocation list is checked on every request against a Redis-backed cache with a 15s TTL...",
    type: "Technical Docs",
    relevance: 88,
    tags: ["sessions", "redis", "security"],
    source: "System Architecture.pdf",
  },
  {
    id: "s3",
    title: "Engineering Meeting — Aug 28",
    snippet:
      "Decided to migrate the payments service to the new event bus by end of Q4. Priya to own timelines; Aarav to review the schema contract...",
    type: "Meetings",
    relevance: 76,
    tags: ["meeting", "payments"],
    source: "Engineering Meeting — Aug 28.docx",
  },
  {
    id: "s4",
    title: "Q1 Product Priorities",
    snippet:
      "Top three bets: (1) knowledge graph GA, (2) enterprise SSO, (3) inline citations. Success metrics are activation lift and enterprise pipeline...",
    type: "Projects",
    relevance: 71,
    tags: ["roadmap", "strategy"],
    source: "Product Roadmap.pdf",
  },
];

export const graphData = {
  nodes: [
    { id: "n1", label: "MemHub Core", type: "concept", x: 500, y: 300, r: 30, primary: true },
    { id: "n2", label: "Auth Service", type: "technology", x: 300, y: 180, r: 22 },
    { id: "n3", label: "JWT Docs", type: "document", x: 160, y: 260, r: 20 },
    { id: "n4", label: "Engineering Team", type: "people", x: 250, y: 420, r: 22 },
    { id: "n5", label: "System Architecture.pdf", type: "document", x: 500, y: 480, r: 22 },
    { id: "n6", label: "Payments Service", type: "technology", x: 720, y: 420, r: 22 },
    { id: "n7", label: "Roadmap Q1", type: "project", x: 780, y: 240, r: 22 },
    { id: "n8", label: "Aug 28 Meeting", type: "meeting", x: 620, y: 130, r: 20 },
    { id: "n9", label: "Vector DB", type: "technology", x: 420, y: 130, r: 20 },
    { id: "n10", label: "Priya N.", type: "people", x: 900, y: 340, r: 20 },
    { id: "n11", label: "Knowledge Graph", type: "concept", x: 380, y: 320, r: 18 },
    { id: "n12", label: "RAG Pipeline", type: "concept", x: 600, y: 350, r: 18 },
  ],
  edges: [
    ["n1", "n2"], ["n1", "n5"], ["n1", "n6"], ["n1", "n7"], ["n1", "n9"], ["n1", "n11"], ["n1", "n12"],
    ["n2", "n3"], ["n2", "n4"], ["n4", "n8"], ["n5", "n6"], ["n7", "n10"], ["n7", "n8"],
    ["n9", "n12"], ["n11", "n12"], ["n6", "n10"],
  ],
};

export const sampleChat = [
  {
    role: "user",
    content: "How does our authentication system work?",
  },
  {
    role: "assistant",
    content:
      "Our authentication is built on a stateless **JWT-based flow**. Users authenticate via email or Google SSO, at which point the identity service issues a signed access token (15 min TTL) and a rotating refresh token stored as an HTTP-only cookie.\n\nKey properties:\n\n- **Signing:** asymmetric RS256, keys rotated every 90 days.\n- **Revocation:** Redis-backed deny-list checked on every request (15s TTL cache).\n- **Sessions:** enforced per-device with fingerprint hashing.",
    confidence: 0.94,
    sources: [
      { id: 1, title: "Authentication Architecture.pdf", type: "PDF", meta: "2.4 MB • Feb 04" },
      { id: 2, title: "Backend Documentation.md", type: "MD", meta: "412 KB • Feb 08" },
      { id: 3, title: "Engineering Meeting — Aug 28", type: "DOCX", meta: "168 KB • Aug 28" },
    ],
  },
];

export const promptCards = [
  { title: "Summarize our latest project meeting", icon: "Calendar" },
  { title: "Find all documents related to authentication", icon: "ShieldCheck" },
  { title: "Explain our system architecture", icon: "Network" },
  { title: "What decisions were made recently?", icon: "History" },
];
