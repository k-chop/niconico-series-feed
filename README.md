# niconico-series-feed

- ニコニコ動画のシリーズページを取得して RSS フィードを返すやつ
- Google Cloud Functions で使う

## Requirements

- Node 18
- pnpm

## How to Build

- `pnpm install`

## Debug

- `pnpm dev`

## Deploy

- `pnpm build`
- Copy `dist/index.js`
- Paste your Cloud Functions
