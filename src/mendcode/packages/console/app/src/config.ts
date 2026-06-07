/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "",

  // GitHub
  github: {
    repoUrl: "/docs",
    starsFormatted: {
      compact: "150K",
      full: "150,000",
    },
  },

  // Social links
  social: {
    twitter: "/docs",
    discord: "/auth",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "850",
    commits: "11,000",
    monthlyUsers: "6.5M",
  },
} as const
