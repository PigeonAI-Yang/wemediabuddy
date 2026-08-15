import { scrapeConfiguredSite } from "./site";

export default async function scrapeToutiaoContent() {
  return scrapeConfiguredSite({
    label: "toutiao",
    title: [{ selector: "div.article-content > h1" }],
    author: [{ selector: "span.name" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["article"],
    digest: [{ selector: 'meta[name="description"]', attribute: "content" }],
  });
}
