import { CheerioAPI, load } from "cheerio";
import fetch from "cross-fetch";
import { Feed } from "feed";
import { Logging } from "@google-cloud/logging";
import { LogEntry } from "@google-cloud/logging/build/src/entry.js";
import opentelemetry from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter";

const isDevelopment = process.env.NODE_ENV !== "production";

const logging = new Logging();

const provider = new BasicTracerProvider();
provider.register();
const exporter = new TraceExporter();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
const tracer = opentelemetry.trace.getTracer("basic");

let rootContext = opentelemetry.propagation.extract(
  opentelemetry.context.active(),
  {}
);

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
  const date = element.uploadDate;
  const description = element.description;

  return { link, title, image, date, description };
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

  const fetchSpan = startSpan("fetch");

  let body = await fetch(`https://www.nicovideo.jp/series/${seriesId}`).then(
    (res) => res.text()
  );

  fetchSpan.end();

  const parseSpan = startSpan("parse");

  let $ = load(body);
  let jsonLD = extractJsonLD($);
  let initialData = extractInitialAPIData($);
  let data = initialData.nvapi[0].body.data;
  const canonicalUrl = extractCanonicalUrl($);

  parseSpan.end();

  const seriesCount = data.totalCount;

  // 100件以上の場合は末尾のページを取得
  if (100 < seriesCount) {
    let pageNo = Math.floor(seriesCount / 100);
    if (seriesCount % 100 !== 0) pageNo += 1;

    const reFetchSpan = startSpan("reFetch");

    body = await fetch(`${canonicalUrl}?page=${pageNo}`).then((res) =>
      res.text()
    );

    reFetchSpan.end();

    const reParseSpan = startSpan("reParse");

    // 再度データを取得
    $ = load(body);
    initialData = extractInitialAPIData($);
    data = initialData.nvapi[0].body.data;
    jsonLD = extractJsonLD($);

    reParseSpan.end();
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

  const createFeedSpan = startSpan("createFeed");

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
      description: entry.description,
      content: entry.link,
      image: entry.image,
      date: new Date(entry.date),
    });
  });

  createFeedSpan.end();

  writeLog({ severity: "INFO" }, `Create feed successfully: ${canonicalUrl}`);

  if (isDevelopment) {
    console.log(feed.rss2());
  }

  res?.status(200)?.send(feed.rss2());
};

const startSpan = (spanName: string) =>
  tracer.startSpan(spanName, undefined, rootContext);

export const scrape = async (req: any, res: any) => {
  rootContext = opentelemetry.propagation.extract(
    opentelemetry.context.active(),
    {
      traceparent: req?.headers?.traceparent,
    }
  );

  try {
    await check(req, res);
  } catch (err) {
    writeLog({ severity: "ERROR" }, { content: err });
    res?.status(500)?.send("something went wrong. please check logs");
  }
};

if (isDevelopment) {
  scrape(null, null);
}
