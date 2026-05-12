export type Role = {
  period: string;
  title: string;
  company: string;
  href?: string;
  location?: string;
  summary?: string | string[];
  bullets?: Array<string | { text: string; sub?: string[] }>;
};

export type Award = {
  year: string;
  title: string;
  body: string;
  org?: string;
  orgHref?: string;
};

export type SkillGroup = {
  label: string;
  items: string[];
};

export const profile = {
  name: "Jetz Alipalo",
  role: "Software Engineer",
  location: "Wellington, New Zealand",
  email: "jalipalo@gmail.com",
  phone: "+64 21 024 55215",
  github: "j10ra",
  links: [
    { label: "GitHub", href: "https://github.com/j10ra" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/jetzalipalo/" },
    { label: "Upwork", href: "https://www.upwork.com/freelancers/jalipalo" },
  ],
  tagline: "Building production web platforms since 2008.",
  lede:
    "Senior engineer with sixteen years across finance, logistics, and marketing. AI-augmented engineering — local-first React, sync architecture, custom MCP servers, and coding-agent skill suites that collapse multi-hour work into minutes.",
};

export const stats: Array<{ value: string; label: string }> = [
  { value: "16+", label: "Years engineering" },
  { value: "10+", label: "Companies shipped" },
  { value: "AI", label: "Augmented practice" },
  { value: "3", label: "Countries · AU / NZ / PH" },
];

export const experience: Role[] = [
  {
    period: "2023 — Present",
    title: "Senior Software Engineer",
    company: "Qube",
    href: "https://qube.com.au/",
    location: "Australia / NZ",
    summary: [
      "Full-stack work across Angular, React, Expo, C#, and SQL — paired with a heavy investment in AI-augmented workflows that compress investigation, planning, and review into the loop where it counts.",
      "Tech-lead voice with the CIO on architecture and direction. Led the modernisation of two production systems now in use company-wide across depots in New Zealand and Australia.",
    ],
    bullets: [
      {
        text: "Built private MCP servers and coding-agent skill suites that compress domain workflows — DB exploration, log triage, EDI tracing, ticket-to-PR — into single agent calls. Multi-hour investigations now run in minutes.",
        sub: [
          "Internal tooling for SQL across multiple environments, log routing across App Insights / blob / DB sources, and end-of-day reporting from Azure DevOps + memory store.",
          "Adopted across the team's day-to-day — code review, documentation, debugging.",
        ],
      },
      "Shipped a lightweight React Native shell that unifies the company's web applications onto controlled tablets, replacing several legacy clients.",
      {
        text: "Designed a local-first architecture on IndexedDB (Dexie.js) with a custom sync protocol, conflict handling, and background reconciliation.",
        sub: [
          "Cut API traffic by ~40% through smart caching strategies.",
          "Apps usable on poor connectivity via offline-first data access.",
          "Background sync for seamless offline-to-online transitions.",
        ],
      },
      "Migrated FieldOps from MVC to React with offline-first capability, enabling field operators to work without coverage.",
      "Migrated the Estimate system to a local-first React stack — instant data access, offline operation, simpler user flows.",
      "Own CI/CD in Azure DevOps and deployments to Azure services and on-prem infrastructure.",
      "Set the bar on frontend code quality, author the development guidelines, and oversee the helpdesk function.",
    ],
  },
  {
    period: "2019 — 2023",
    title: "Senior Web Engineer, Team Lead",
    company: "ING",
    href: "https://ing.com.ph/home",
    location: "Philippines",
    summary:
      "Joined as a senior engineer; promoted to lead the Onboarding and KYC teams. Aligned local delivery to ING's global engineering standards and acted as the liaison between product, chapter leads, and architects.",
    bullets: [
      "Translated complex product requirements into technical specs and user stories; designed user flows, data workflows, and database schemas alongside chapter leads and architects.",
      "Held the line on frontend code quality. Drove refactors and migrations to reduce technical debt and improve the end-to-end test suite.",
      "Mentored and coached engineers — pairing, code review, technical writeups — to compound the team's depth over time.",
      "Carried the on-call rotation for production systems the team owned, including out-of-hours support.",
      "Stack: JavaScript ES6+, Node.js, Web Components, Polymer, Lit, modern CSS, service workers, i18n/l10n, accessibility (WCAG).",
    ],
  },
  {
    period: "2015 — 2019",
    title: "Senior Front-End Developer",
    company: "Liquid Interactive",
    href: "http://www.liquidinteractive.com.au/",
    location: "Australia",
    summary: [
      "Interactive marketing agency. Built education platforms used by school leaders, staff, and students across desktop, tablet, and mobile.",
      "Trusted with the DreamWorks engagement — flown to Australia to set the code benchmark for the mini-game apps. Chose Phaser.js over Three.js after prototyping, for mobile performance and faster iteration on 2D mechanics.",
    ],
    bullets: [
      "Authored and maintained the team's frontend standards — JavaScript, HTML, CSS production guidelines and a project-kickstart template.",
      "Hardened sites on Sitefinity and Sitecore CMS to WCAG AA and screen-reader-friendly markup.",
      "Built views and templates in C# / Razor; introduced Mustache and Handlebars for the frontend layer.",
      "Introduced BEM and an SCSS-based modular architecture for reusable, scalable component systems.",
      "Ran build pipelines on Grunt and Gulp — minification, compilation, unit tests, linting.",
    ],
  },
  {
    period: "2013 — 2014",
    title: "Senior Front-End Developer",
    company: "Visual Jazz Isobar",
    href: "http://www.isobar.com/au/home",
    location: "Australia",
    summary:
      "Part of one of Australia's largest front-end practices. Built enterprise web applications with multi-channel and multi-tier architectures, integrating against MVC, Sitecore, and Umbraco.",
    bullets: [
      "Led technical direction on emerging tooling — jQuery into Angular.js, Grunt, Handlebars — and shaped the templating choices for the broader team.",
      "Worked alongside managers and tech leads on estimates, architectural choices, and innovative solutions for client delivery.",
      "Cross-browser, cross-device discipline with fluid layout design under Agile/Scrum.",
    ],
  },
  {
    period: "Jan — Jul 2013",
    title: "Senior Front-End Developer",
    company: "Oxygen Ventures",
    href: "http://www.oxygenventures.com.au/",
    location: "Australia",
    summary:
      "Owned the front-end across web, social, email, and application surfaces for internal initiatives spanning the venture portfolio. ASP.NET MVC4 alongside HTML5 / CSS3 / jQuery, with cross-browser and SEO discipline under Agile/Scrum.",
  },
  {
    period: "2009 — 2023",
    title: "Front-End Engineer / Designer",
    company: "Upwork (formerly oDesk)",
    href: "https://www.upwork.com/o/profiles/users/_~0167ebb26079457657/",
    location: "Contract",
    summary: [
      "Long-running independent practice — repeat engagements with clients ranging from small startups to large enterprise. Mobile and desktop web, modern JavaScript, and interface design end-to-end.",
      "Server-side work in PHP and ASP.NET MVC where the front end required it. Identity, iconography, and bespoke bitmaps for software UIs.",
    ],
  },
  {
    period: "2010 — 2012",
    title: "Website Designer",
    company: "Campertravel",
    href: "http://www.campertravel.com.au/",
    location: "Australia",
    summary:
      "Designed and built customer-facing pages with a focus on lead generation. Frontend in HTML/CSS/JavaScript, backend in C#.",
  },
  {
    period: "2009 — 2010",
    title: "Designer",
    company: "99designs",
    location: "Contributor",
    summary:
      "Graphic and interface work for web, print, and electronic media. Identity, iconography, and bespoke bitmaps for software UIs.",
  },
  {
    period: "2008",
    title: "IT Consultant",
    company: "Sugar Mountain Media",
    href: "http://sugarmountainmedia.com/",
    summary:
      "Built a digital video library tracking system, a financial management system, and a digital sourcebook.",
  },
  {
    period: "2006 — 2008",
    title: "Data Encoder",
    company: "La Consolacion College — Finance Department",
    summary:
      "Managed student accounts and proposed enhancements to the internal Student Information System.",
  },
];

export const skills: SkillGroup[] = [
  {
    label: "Languages",
    items: ["TypeScript", "JavaScript", "C#", "HTML", "CSS / SCSS", "SQL"],
  },
  {
    label: "Frameworks & libraries",
    items: [
      "React",
      "React Native / Expo",
      "Next.js",
      "Angular",
      "Node.js",
      "Express",
      "Encore",
      "tRPC",
      "GraphQL",
      "Redux / Zustand",
      "TanStack Query",
      "Zod",
      "Phaser",
      "Material UI",
    ],
  },
  {
    label: "Data & storage",
    items: [
      "Drizzle",
      "Prisma",
      "Dexie.js (IndexedDB)",
      "SQL / NoSQL",
      "Local-first sync",
    ],
  },
  {
    label: "Platform & tooling",
    items: [
      "Azure DevOps",
      "Docker",
      "Git",
      "Webpack",
      "Rollup",
      "Jira",
      "VS Code",
      "Chrome DevTools",
    ],
  },
];

export const aiStack: SkillGroup = {
  label: "AI · agent stack",
  items: [
    "Frontier model access",
    "Coding agents",
    "MCP (custom servers)",
    "Agent skills / subagents",
    "Ollama",
    "Custom embedders",
    "Hybrid recall (vector + tsvector)",
    "Postgres / pgvector",
    "Self-hosted inference",
  ],
};

export const practice =
  "Comfortable across the stack — framework internals, sync engines, and data layers, not just the happy path. Local-first, sync-capable architectures with offline as a default. Component systems designed for reuse across teams and stacks. Custom MCP servers and agent skill suites amplify the work; they don't replace the engineering judgement underneath.";

export type Project = {
  name: string;
  status: string;
  href?: string;
  blurb: string;
  tags: string[];
};

export const building: Project[] = [
  {
    name: "AskAnna",
    status: "Live · production",
    href: "https://www.askanna.com.au/",
    blurb:
      "Production AI assistant for ASX market intelligence. Built as part of the AskAnna engineering team — React frontend, Encore TypeScript services, WebSocket-driven real-time notifications, and the RAG pipeline that ingests, chunks, and embeds ASX publications so the LLM answers from live source data, not training-time knowledge.",
    tags: [
      "React",
      "TypeScript",
      "Encore",
      "WebSockets",
      "Supabase",
      "pgvector",
      "RAG",
      "Embeddings",
      "Stripe",
    ],
  },
  {
    name: "Internal MCP suites",
    status: "Internal · production",
    blurb:
      "Domain-specific coding-agent skill suites and MCP servers built for the day job. Encode SQL, log triage, EDI debugging, and reporting workflows across multiple internal tools so investigation becomes a single agent call.",
    tags: ["MCP", "Coding agents", "Skills", "Workflow"],
  },
  {
    name: "mneme",
    status: "Soon · open source",
    blurb:
      "Cross-machine memory store for AI coding assistants. Pluggable LLM and embedder backends behind tiny interfaces, hybrid recall (semantic + keyword + recency), self-hosted on a private inference VM.",
    tags: [
      "TypeScript",
      "Postgres",
      "pgvector",
      "Ollama",
      "MCP",
      "Self-hosted",
    ],
  },
  {
    name: "lens-engine",
    status: "Live · open source",
    href: "https://lens-engine.com/",
    blurb:
      "Self-hosted platform for AI tooling experiments — inference, embedding, tunnels, and the substrate that mneme and a handful of other projects run on.",
    tags: ["Self-hosted", "Tunnels", "Inference VM", "GPU"],
  },
];

export const education = [
  {
    period: "2006 — 2012",
    title: "B.Sc. Information Management",
    company: "La Consolacion College",
    summary:
      "Programme oriented around producing nationally accredited and globally competitive IT professionals.",
  },
];

export const awards: Award[] = [
  {
    year: "2010",
    title: "Champion — I Love Technology",
    body: "Digital Art & Photography on-the-spot competition.",
    org: "BNEFIT",
  },
  {
    year: "2009",
    title: "Champion — On-the-Spot Digital Art",
    body: "4th ICT Educational Fair, December 3–4.",
  },
  {
    year: "2007",
    title: "Champion — On-the-Spot Web Design",
    body: "School of Business and Information Technology.",
    org: "La Consolacion College",
    orgHref: "https://lcc.edu.ph/sbit/",
  },
  {
    year: "2007",
    title: "1st Place — Poster Making Contest",
    body: "Inter-school competition.",
    org: "La Consolacion College",
    orgHref: "https://lcc.edu.ph/",
  },
  {
    year: "2006",
    title: "Champion — On-the-Spot Flyers Making",
    body: "Inter-school competition.",
    org: "La Consolacion College",
    orgHref: "https://lcc.edu.ph/",
  },
];
