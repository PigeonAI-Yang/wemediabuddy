interface PreprocessorOptions {
  removeEmptyParagraphs?: boolean;
  removeNonEditableElements?: boolean;
  tagsToRemove?: string[];
}

const defaultOptions: PreprocessorOptions = {
  removeEmptyParagraphs: true,
  removeNonEditableElements: true,
  tagsToRemove: ["style", "script", "svg", "link"],
};

export function preprocessor(content: string, options: PreprocessorOptions = defaultOptions): string {
  try {
    const resolvedOptions = { ...defaultOptions, ...options };
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, "text/html");

    // 处理图片
    Array.from(doc.getElementsByTagName("img")).forEach((img) => {
      if (!img.getAttribute("referrerpolicy")) {
        img.setAttribute("referrerpolicy", "no-referrer");
      }
      const dataSrc = img.getAttribute("data-src");
      if (dataSrc) {
        img.setAttribute("src", dataSrc);
        console.debug("设置src为data-src", dataSrc);
      }
      const src = img.getAttribute("src");
      if (src?.startsWith("//")) {
        img.setAttribute("src", `https:${src}`);
      }
      img.removeAttribute("alt");
      img.removeAttribute("title");
    });

    // 处理视频
    Array.from(doc.getElementsByTagName("video")).forEach((video) => {
      const poster = video.getAttribute("poster");
      if (poster && video.parentNode) {
        const img = doc.createElement("img");
        img.setAttribute("src", poster);
        video.parentNode.replaceChild(img, video);
        console.debug("将视频替换为图片", video, img);
      } else if (video.parentNode) {
        video.parentNode.removeChild(video);
      }
    });

    // 移除特定标签
    if (resolvedOptions.tagsToRemove?.length) {
      resolvedOptions.tagsToRemove.forEach((tag) => {
        doc.querySelectorAll(tag).forEach((el) => el.remove());
      });
    }

    // 移除不可编辑的元素
    if (resolvedOptions.removeNonEditableElements) {
      const nonEditableElements = doc.querySelectorAll('*[contenteditable="false"]');
      console.debug("不可编辑的元素 ", nonEditableElements);
      nonEditableElements.forEach((el) => el.remove());
    }

    // 移除空段落
    if (resolvedOptions.removeEmptyParagraphs) {
      doc.querySelectorAll("p").forEach((p) => {
        if (p.innerHTML.trim() === "") {
          p.remove();
        }
      });
    }

    doc.querySelectorAll("a").forEach((link) => {
      const replacement = doc.createElement("span");
      replacement.innerHTML = link.innerHTML;
      link.replaceWith(replacement);
    });

    return doc.body.innerHTML;
  } catch (error) {
    console.error("预处理内容时出错:", error);
    return content; // 发生错误时返回原始内容
  }
}
