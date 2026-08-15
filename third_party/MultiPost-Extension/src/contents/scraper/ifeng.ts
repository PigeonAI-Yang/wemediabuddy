import { scrapeConfiguredSite } from "./site";

export default async function scrapeIfengContent() {
  return scrapeConfiguredSite({
    label: "ifeng",
    title: [{ selector: 'meta[property="og:title"]', attribute: "content" }],
    author: [{ selector: "a.author-name" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.index_main_content_j-HoG"],
    digest: [{ selector: 'meta[property="og:description"]', attribute: "content" }],
  });
}
