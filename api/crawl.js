export default async function handler(request, response) {
  try {
    const { url } = request.query;

    if (!url) {
      return response.status(400).json({ error: "Missing URL. Add ?url=https://example.com" });
    }

    let startUrl;

    try {
      startUrl = new URL(url);
    } catch {
      return response.status(400).json({ error: "Invalid URL. Use full URL like https://example.com" });
    }

    if (!["http:", "https:"].includes(startUrl.protocol)) {
      return response.status(400).json({ error: "Only http and https URLs are allowed." });
    }

    const maxPages = 12;
    const visited = new Set();
    const queue = [normalizeUrl(startUrl.href)];
    const pages = [];
    const edges = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const currentUrl = queue.shift();

      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const pageData = await crawlPage(currentUrl, startUrl.hostname);
      pages.push(pageData);

      pageData.links.forEach(link => {
        edges.push({ from: currentUrl, to: link });

        if (!visited.has(link) && queue.length + pages.length < maxPages) {
          queue.push(link);
        }
      });
    }

    const crawledUrls = new Set(pages.map(p => p.url));
    const filteredEdges = edges.filter(e => crawledUrls.has(e.from) && crawledUrls.has(e.to));

    const diagnosedPages = pages.map(p => diagnosePage(p));

    const priorityQueue = buildPriorityQueue(diagnosedPages, filteredEdges);

    const summary = buildSummary(diagnosedPages, filteredEdges, priorityQueue);

    return response.status(200).json({
      crawledUrl: normalizeUrl(startUrl.href),
      pages: diagnosedPages,
      edges: filteredEdges,
      priorityQueue,
      summary
    });

  } catch (error) {
    return response.status(500).json({
      error: "Crawler failed.",
      details: error.message
    });
  }
}

async function crawlPage(pageUrl, rootHostname) {
  try {
    const res = await fetch(pageUrl);
    const html = await res.text();

    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : "Untitled";

    const links = [...html.matchAll(/href="(.*?)"/g)]
      .map(m => {
        try {
          const u = new URL(m[1], pageUrl);
          if (u.hostname === rootHostname) return normalizeUrl(u.href);
        } catch {}
        return null;
      })
      .filter(Boolean);

    return {
      url: normalizeUrl(pageUrl),
      statusCode: res.status,
      title,
      links: [...new Set(links)]
    };
  } catch {
    return {
      url: normalizeUrl(pageUrl),
      statusCode: 0,
      title: "Failed",
      links: []
    };
  }
}

function diagnosePage(page) {
  let diagnosis = "Healthy";
  let issue = "No issue";
  let recommendation = "No action needed";

  if (page.statusCode === 0) {
    diagnosis = "Failed";
    issue = "Page failed to load";
    recommendation = "Check server or JS rendering";
  } else if (page.statusCode >= 400) {
    diagnosis = "Broken";
    issue = "Page returns error";
    recommendation = "Fix or redirect page";
  } else if (page.links.length === 0) {
    diagnosis = "Dead End";
    issue = "No outgoing links";
    recommendation = "Add navigation or CTA";
  }

  const score = calculateScore(diagnosis);
  const level = getPriorityLevel(score);

  const actionBoard = buildActionBoard(diagnosis, score);

  return {
    ...page,
    diagnosis,
    issue,
    recommendation,
    priorityScore: score,
    priorityLevel: level,
    actionBoard,
    actionCard: {
      title: `${level} Priority`,
      whatIsWrong: issue,
      whyItMatters: "Impacts user journey and conversions",
      howToFix: recommendation
    }
  };
}

function calculateScore(d) {
  if (d === "Broken") return 90;
  if (d === "Failed") return 85;
  if (d === "Dead End") return 60;
  return 20;
}

function getPriorityLevel(score) {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 35) return "Medium";
  return "Low";
}

function buildActionBoard(diagnosis, score) {
  let category = "General";
  let impact = "Low";
  let effort = "Low";

  if (diagnosis === "Broken" || diagnosis === "Failed") {
    category = "Technical";
    impact = "High";
    effort = "High";
  }

  if (diagnosis === "Dead End") {
    category = "Navigation";
    impact = "Medium";
    effort = "Low";
  }

  let bucket = "Cleanup";
  if (impact === "High" && effort === "Low") bucket = "Quick Win";
  else if (impact === "High") bucket = "High Impact";

  return {
    category,
    impact,
    effort,
    fixStatus: "Open",
    actionBucket: bucket,
    actionType: diagnosis
  };
}

function buildPriorityQueue(pages, edges) {
  return pages
    .filter(p => p.priorityScore >= 35)
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function buildSummary(pages, edges, queue) {
  return {
    totalPages: pages.length,
    totalEdges: edges.length,
    actionableFixes: queue.length
  };
}

function normalizeUrl(url) {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}
