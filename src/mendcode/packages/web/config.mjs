const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://mendcode.ai" : `https://${stage}.mendcode.ai`,
  console: stage === "production" ? "https://mendcode.ai/auth" : `https://${stage}.mendcode.ai/auth`,
  email: "contact@mendcode.ai",
  socialCard: "https://social-cards.sst.dev",
  github: "https://mendcode.ai",
  discord: "https://mendcode.ai",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
