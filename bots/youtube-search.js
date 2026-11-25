const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const MAX_RESULTS = 5;

function normalizeVideo(item) {
  const videoId = item.id?.videoId;
  const title = item.snippet?.title;
  const channel = item.snippet?.channelTitle;
  if (
    typeof videoId !== "string" ||
    !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
    typeof title !== "string" ||
    typeof channel !== "string"
  ) {
    return null;
  }
  return {
    source: "youtube",
    videoId,
    title,
    channel,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

async function searchYouTubeVideos(query, apiKey, fetchImpl = globalThis.fetch) {
  const url = new URL(YOUTUBE_SEARCH_URL);
  url.search = new URLSearchParams({
    key: apiKey,
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(MAX_RESULTS),
  });
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`YouTube Data API HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message || "YouTube Data API so'rovni rad etdi.");
  }
  if (!Array.isArray(payload.items)) {
    throw new Error("YouTube Data API javobi noto'g'ri formatda.");
  }
  return payload.items.map(normalizeVideo).filter(Boolean).slice(0, MAX_RESULTS);
}

module.exports = searchYouTubeVideos;
