// Downloads the pictures named in ground-truth.json from the channel's public preview, one page
// and one picture at a time.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchChannelPage, parsePhotoPosts } from '../../mirror/lib/telegram.mjs';
import { getBytes } from '../../mirror/lib/http.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: fetch-pictures.mjs <dir>');
mkdirSync(dir, { recursive: true });
const wanted = Object.keys(JSON.parse(readFileSync(new URL('./ground-truth.json', import.meta.url), 'utf8')))
  .map((file) => Number(file.split('.')[0])).filter((id) => !existsSync(join(dir, `${id}.jpg`))).sort((a, b) => a - b);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
while (wanted.length) {
  const id = wanted.at(-1);
  const posts = parsePhotoPosts(await fetchChannelPage('SumyEnergo', { before: id + 1 }));
  await pause(1200);
  for (const post of posts) {
    const at = wanted.indexOf(post.id);
    if (at < 0) continue;
    writeFileSync(join(dir, `${post.id}.jpg`), await getBytes(post.photos[0]));
    wanted.splice(at, 1);
    await pause(600);
  }
  if (wanted.at(-1) === id) { console.warn(`post ${id} not found`); wanted.pop(); }
}
