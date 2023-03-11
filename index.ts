import { CheerioAPI, load } from "cheerio";
import fetch from "cross-fetch";
import { Feed } from "feed";
import { Logging } from "@google-cloud/logging";
import { LogEntry } from "@google-cloud/logging/build/src/entry.js";

const isDevelopment = process.env.NODE_ENV !== "production";

const logging = new Logging();

type ListElement = {
  "@type": string;
  position: number;
  "@id": string;
  name: string;
  description: string;
  caption: string;
  url: string;
  duration: string;
  uploadDate: string;
  embedUrl: string;
  interactionStatistic: {}[];
  requiresSubscription: boolean;
  isAccessibleForFree: boolean;
  thumbnail: { "@type": string; url: string }[];
  thumbnailUrl: string[];
};

type JsonLD = {
  "@context": string;
  "@type": string;
  itemListElement: ListElement[];
};

type InitialData = {
  state: {};
  nvapi: {
    method: string;
    path: string;
    templatePath: string;
    query: {
      page: number;
      pageSize: number;
      sensitiveContents: string;
    };
    body: {
      meta: { status: number };
      data: {
        detail: {
          id: number;
          owner: unknown;
          title: string;
          description: string;
          decorateDescriptionHtml: string;
          thumbnailUrl: string;
          isListed: boolean;
          createdAt: string;
          updatedAt: string;
        };
        totalCount: number;
        items: {
          meta: unknown;
          video: {
            id: string;
            title: string;
          };
        }[];
      };
    };
  }[];
};

const extractCanonicalUrl = (body: CheerioAPI) => {
  return body(`link[rel="canonical"]`).attr("href");
};

const extractJsonLD = (body: CheerioAPI): JsonLD => {
  const scriptTags = body("script");
  const jsonDataRaw: any = scriptTags[scriptTags.length - 1].children[0];
  return JSON.parse(jsonDataRaw.data);
};

const extractInitialAPIData = (body: CheerioAPI) => {
  return body("#js-initial-userpage-data").data("initial-data") as InitialData;
};

const extractEntry = (element: ListElement) => {
  const link = element.url;
  const title = element.name;
  const image = element.thumbnailUrl[0];

  return { link, title, image };
};

const log = logging.log("niconico-series-feed");

const writeLog = (
  metadata: LogEntry | undefined,
  data: string | {} | undefined
) => {
  if (isDevelopment) {
    console.log(data);
  } else {
    const entry = logging.entry(metadata, data);
    log.write(entry);
  }
};

const check = async (req: any, res: any) => {
  const seriesId = req?.query?.seriesId ?? process.env.SERIES_ID;
  if (!seriesId) {
    throw new Error(`No series id specified`);
  }

  let body = await fetch(`https://www.nicovideo.jp/series/${seriesId}`).then(
    (res) => res.text()
  );

  let $ = load(body);
  let jsonLD = extractJsonLD($);
  let initialData = extractInitialAPIData($);
  let data = initialData.nvapi[0].body.data;
  const canonicalUrl = extractCanonicalUrl($);

  const seriesCount = data.totalCount;

  // 100件以上の場合は末尾のページを取得
  if (100 < seriesCount) {
    let pageNo = Math.floor(seriesCount / 100);
    if (seriesCount % 100 !== 0) pageNo += 1;

    body = await fetch(`${canonicalUrl}?page=${pageNo}`).then((res) =>
      res.text()
    );

    // 再度データを取得
    $ = load(body);
    initialData = extractInitialAPIData($);
    data = initialData.nvapi[0].body.data;
    jsonLD = extractJsonLD($);
  }

  const feedTitle = data.detail.title;

  writeLog(
    { severity: "INFO", labels: { logType: "feedCount" } },
    `Count ${seriesCount} for ${feedTitle}`
  );

  // 20件分のエントリーを取得
  const entries = jsonLD.itemListElement
    .reverse()
    .slice(0, 20)
    .map(extractEntry);

  if (entries.length === 0) {
    writeLog(
      { severity: "CRITICAL" },
      `No entries found: ${canonicalUrl} 「${feedTitle}」`
    );
    res?.status(404)?.send("No entries found");
    return;
  }

  const feed = new Feed({
    title: feedTitle,
    description: feedTitle,
    id: "",
    link: `https://www.nicovideo.jp/series/${seriesId}`,
    copyright: "",
  });

  entries.forEach((entry) => {
    feed.addItem({
      title: entry.title,
      id: entry.link,
      link: entry.link ?? "",
      description: entry.link,
      content: entry.link,
      image: entry.image,
      date: new Date(),
    });
  });

  writeLog({ severity: "INFO" }, `Create feed successfully: ${canonicalUrl}`);

  if (isDevelopment) {
    console.log(feed.rss2());
  }

  res?.status(200)?.send(feed.rss2());
};

export const scrape = async (req: any, res: any) => {
  try {
    check(req, res);
  } catch (err) {
    writeLog({ severity: "ERROR" }, { content: err });
    res?.status(500)?.send("something went wrong. please check logs");
  }
};

if (isDevelopment) {
  scrape(null, null);
}
