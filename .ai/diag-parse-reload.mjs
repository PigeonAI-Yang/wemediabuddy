
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
function unwrapTweetResult(value){ let current=value; for(let i=0;i<4;i++){ if(!current||typeof current!=='object') return null; if(current.legacy&&typeof current.rest_id==='string') return current; if(current.tweet&&typeof current.tweet==='object'){current=current.tweet;continue;} if(current.result&&typeof current.result==='object'){current=current.result;continue;} return null;} return null; }
function numberOrNull(v){ if(v==null)return null; const n=typeof v==='number'?v:Number(String(v).replace(/[^\d.-]/g,'')); return Number.isFinite(n)?n:null; }
function extractTimelineMedia(legacy){ const extended=legacy.extended_entities?.media; const basic=legacy.entities?.media; const mediaItems=Array.isArray(extended)?extended:Array.isArray(basic)?basic:[]; const images=[]; let hasVideo=false,videoPoster=null,videoUrl=null; for(const item of mediaItems){ if(!item||typeof item!=='object') continue; const type=item.type||''; const mediaUrl=item.media_url_https||item.media_url||null; if(type==='photo'&&mediaUrl) images.push(mediaUrl); if(type==='video'||type==='animated_gif'){ hasVideo=true; if(mediaUrl) videoPoster=mediaUrl; const variants=item.video_info?.variants; if(Array.isArray(variants)){ const mp4s=variants.filter(v=>v&&v.content_type==='video/mp4'&&typeof v.url==='string').sort((a,b)=>Number(b.bitrate||0)-Number(a.bitrate||0)); if(mp4s[0]) videoUrl=mp4s[0].url; } } } return {images,imageThumbs:images,hasVideo,videoPoster,videoUrl}; }
function authorFromTweet(tweet){ const userResult=tweet.core?.user_results?.result; const userCore=userResult?.core||{}; const screenName=typeof userCore.screen_name==='string'?userCore.screen_name:null; return {handle:screenName?`@${screenName}`:null,displayName:typeof userCore.name==='string'?userCore.name:null,avatarUrl:typeof userResult?.avatar?.image_url==='string'?userResult.avatar.image_url:null}; }
function listTimelineTweetToPost(tweet, options={}){
  const allowNestedQuote=options.allowNestedQuote!==false; const legacy=tweet.legacy; const restId=tweet.rest_id; if(!legacy||!restId) return null;
  const retweeted=unwrapTweetResult(legacy.retweeted_status_result?.result||tweet.retweeted_status_result?.result||legacy.retweeted_status_result||tweet.retweeted_status_result);
  if(retweeted){ const original=listTimelineTweetToPost(retweeted,{allowNestedQuote:true}); if(!original) return null; return {...original, postKind:'repost', repostedBy:authorFromTweet(tweet)}; }
  const author=authorFromTweet(tweet); if(!author.handle) return null; const screenName=author.handle.slice(1);
  const text=String(legacy.full_text||'').trim(); const createdAt=typeof legacy.created_at==='string'?new Date(legacy.created_at).toISOString():null; const media=extractTimelineMedia(legacy);
  const metrics={replies:numberOrNull(legacy.reply_count),reposts:numberOrNull(legacy.retweet_count),likes:numberOrNull(legacy.favorite_count),bookmarks:numberOrNull(legacy.bookmark_count),views:numberOrNull(tweet.views?.count)};
  let quotedPost=null; if(allowNestedQuote){ const quoted=unwrapTweetResult(legacy.quoted_status_result?.result||tweet.quoted_status_result?.result||legacy.quoted_status_result||tweet.quoted_status_result); if(quoted){ quotedPost=listTimelineTweetToPost(quoted,{allowNestedQuote:false}); if(quotedPost) quotedPost={...quotedPost,postKind:'tweet',repostedBy:null,quotedPost:null}; } }
  if(!text && media.images.length===0 && !media.hasVideo && !quotedPost) return null;
  return {url:`https://x.com/${screenName}/status/${restId}`,authorHandle:author.handle,displayName:author.displayName,avatarUrl:author.avatarUrl,text:text||(media.hasVideo?'[视频]':media.images.length?'[图片]':''),postedAt:createdAt,images:media.images,imageThumbs:media.imageThumbs,hasVideo:media.hasVideo,videoPoster:media.videoPoster,videoUrl:media.videoUrl,postKind:quotedPost?'quote':'tweet',repostedBy:null,quotedPost,metrics};
}
function extract(payload){ const posts=[]; const seen=new Set(); const walk=(node)=>{ if(!node||typeof node!=='object') return; if(Array.isArray(node)){ for(const x of node) walk(x); return;} if(typeof node.rest_id==='string'&&node.legacy&&typeof node.legacy.full_text==='string'){ const post=listTimelineTweetToPost(node); if(post&&!seen.has(post.url)){ seen.add(post.url); posts.push(post);} } for(const [k,v] of Object.entries(node)){ if(k==='retweeted_status_result'||k==='quoted_status_result'||k==='quoted_status_permalink') continue; walk(v);} }; walk(payload); return posts; }

const browser=await chromium.connectOverCDP('http://127.0.0.1:9334');
const page=browser.contexts()[0].pages()[0];
const payloads=[]; page.on('response', async r=>{ if(!r.url().includes('ListLatestTweetsTimeline')) return; try{payloads.push(await r.json());}catch{} });
await page.reload({waitUntil:'domcontentloaded', timeout:30000});
for(let i=0;i<8 && !payloads.length;i++){ await page.mouse.wheel(0,1200); await page.waitForTimeout(350);} 
await page.waitForTimeout(1000);
let posts=[]; for(const p of payloads) posts.push(...extract(p));
const uniq=[]; const s=new Set(); for(const p of posts) if(!s.has(p.url)){s.add(p.url); uniq.push(p);} 
const counts={total:uniq.length,tweet:0,repost:0,quote:0}; for(const p of uniq) counts[p.postKind||'tweet']++;
const samples=uniq.filter(p=>p.postKind!=='tweet').slice(0,8).map(p=>({kind:p.postKind,author:p.authorHandle,text:(p.text||'').slice(0,40),repostedBy:p.repostedBy?.handle||null,quoted:p.quotedPost?{author:p.quotedPost.authorHandle,text:(p.quotedPost.text||'').slice(0,30)}:null}));
console.log(JSON.stringify({payloads:payloads.length,counts,samples},null,2));
await browser.close();
if(counts.total<5 || counts.quote<1) process.exit(2);
