export default async function handler(request, response) {
  try {
    const { url } = request.query;

    if (!url) {
      return response.status(400).json({
        error: "Missing URL. Add ?url=https://example.com"
      });
    }

    let targetUrl;

    try {
      targetUrl = new URL(url);
    } catch {
      return response.status(400).json({
        error: "Invalid URL. Use full URL like https://example.com"
      });
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return response.status(400).json({
        error: "Only http and https URLs are allowed."
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const siteResponse = await fetch(targetUrl.href, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AudiianceBot/0.1"
      }
    });

    clearTimeout(timeout);

    const html = await siteResponse.text();

    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : "Untitled page";

    const linkMatches = [...html.matchAll(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi)];

    const internalLinks = [];

    linkMatches.forEach(match => {
      const href = match[2];

      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
        return;
      }

      try {
        const absoluteUrl = new URL(href, targetUrl.href);

        if (absoluteUrl.hostname === targetUrl.hostname) {
          absoluteUrl.hash = "";
          internalLinks.push(absoluteUrl.href);
        }
      } catch {
        // ignore broken hrefs
      }
    });

    const uniqueLinks = [...new Set(internalLinks)].slice(0, 25);

    return response.status(200).json({
      crawledUrl: targetUrl.href,
      statusCode: siteResponse.status,
      title,
      linksFound: uniqueLinks.length,
      links: uniqueLinks
    });

  } catch (error) {
    return response.status(500).json({
      error: "Crawler failed.",
      details: error.message
    });
  }
}
