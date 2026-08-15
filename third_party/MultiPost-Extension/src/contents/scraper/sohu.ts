import { scrapeConfiguredSite } from "./site";

export default async function scrapeSohuContent() {
  return scrapeConfiguredSite({
    label: "sohu",
    title: [{ selector: 'meta[property="og:title"]', attribute: "content" }],
    author: [{ selector: "a.author-name" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.content-main-detail", "article"],
    digest: [{ selector: 'meta[property="og:description"]', attribute: "content" }],
  });
}
