import { Readability } from "@mozilla/readability";
import scrapeBaijiahaoContent from "./baijiahao";
import scrapeCSDNContent from "./csdn";
import scrapeEastmoneyContent from "./eastmoney";
import scrapeIfengContent from "./ifeng";
import scrapeJianshuContent from "./jianshu";
import scrapeJuejinContent from "./juejin";
import scrapeNeteaseContent from "./netease";
import scrapeNotionContent from "./notion";
import { preprocessor } from "./preprocessor";
import scrapeQqNewsContent from "./qq";
import scrapeSohuContent from "./sohu";
import scrapeTonghuashunContent from "./tonghuashun";
import scrapeToutiaoContent from "./toutiao";
import scrapeWeixinContent from "./wechat";
import scrapeXContent from "./x";
import scrapeXueqiuContent from "./xueqiu";
import scrapeYuqueContent from "./yuque";
import scrapeZhihuContent from "./zhihu";

export interface ArticleData {
  title: string;
  author: string;
  cover: string;
  content: string;
  digest: string;
}

export default async function scrapeContent(): Promise<ArticleData | undefined> {
  const url = window.location.href;

  // 针对不同网址开头使用不同的scraper
  const scraperMap: { [key: string]: () => Promise<ArticleData | undefined> } = {
    "https://blog.csdn.net/": scrapeCSDNContent,
    "https://www.163.com/dy/article/": scrapeNeteaseContent,
    "https://baijiahao.baidu.com/s": scrapeBaijiahaoContent,
    "https://caifuhao.eastmoney.com/news/": scrapeEastmoneyContent,
    "https://new.qq.com/": scrapeQqNewsContent,
    "https://www.sohu.com/a/": scrapeSohuContent,
    "https://www.toutiao.com/article/": scrapeToutiaoContent,
    "https://xueqiu.com/": scrapeXueqiuContent,
    "https://t.10jqka.com.cn/": scrapeTonghuashunContent,
    "https://www.yuque.com/": scrapeYuqueContent,
    "https://x.com/": scrapeXContent,
    "ifeng.com/c/": scrapeIfengContent,
    "notion.site/": scrapeNotionContent,
    "https://zhuanlan.zhihu.com/p/": scrapeZhihuContent,
    "https://mp.weixin.qq.com/s/": scrapeWeixinContent,
    "https://juejin.cn/post/": scrapeJuejinContent,
    "https://www.jianshu.com/p/": scrapeJianshuContent,
  };

  const scraper = Object.keys(scraperMap).find((key) =>
    key.startsWith("http") ? url.startsWith(key) : url.includes(key),
  );
  if (scraper) {
    const article = await scraperMap[scraper]();
    if (article?.content) return article;
  }

  return defaultScraper();
}

async function defaultScraper(): Promise<ArticleData | undefined> {
  console.debug("default spider ...");

  const preprocess = (content: string) => preprocessor(content);

  const article = new Readability(document.cloneNode(true) as Document).parse();

  console.debug("Readability article", article);

  if (!article?.content || !article?.title) {
    // alert(chrome.i18n.getMessage("failedToGetArticleContent"));
    console.log("failedToGetArticleContent");
    return;
  }

  const cover = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
  const title = article.title || "";

  console.debug("title ", title);

  const content = article.content || "";
  const excerpt = article.excerpt || "";

  const articleData: ArticleData = {
    title: title.trim(),
    author: "",
    cover,
    content: preprocess(content.trim()),
    digest: excerpt.trim(),
  };

  return articleData;
}
