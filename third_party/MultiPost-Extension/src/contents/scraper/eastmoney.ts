import { scrapeConfiguredSite } from "./site";

export default async function scrapeEastmoneyContent() {
  return scrapeConfiguredSite({
    label: "eastmoney",
    title: [{ selector: "h1.article-title" }],
    author: [{ selector: "a.auth.name" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.article-body"],
  });
}
