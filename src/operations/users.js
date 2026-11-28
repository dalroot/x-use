const {
  PROFILE_READ_FEATURES,
  DEFAULT_EXPLORE_TIMELINE_ID,
  X_WEB_RELAY_DEFAULTS
} = require('../constants');

/**
 * Normalize a GraphQL tweet result (supporting both legacy and x-web schemas).
 */
function normalizeTweetResult(rawResult) {
  const tr = rawResult?.tweet || rawResult;
  if (!tr) return null;

  const text = tr.details?.full_text ?? tr.legacy?.full_text;
  if (typeof text !== 'string') return null;

  const id = tr.rest_id || tr.legacy?.id_str;
  const userCore = tr.core?.user_results?.result?.core;
  const screenName = userCore?.screen_name || 'i';
  const createdAt =
    tr.legacy?.created_at ||
    (tr.details?.created_at_ms ? new Date(Number(tr.details.created_at_ms)).toISOString() : undefined);

  const urlEntities = tr.url_entities || tr.legacy?.entities?.urls || [];
  const links = urlEntities
    .map((u) => u.expanded_url || u.url)
    .filter(Boolean);

  return {
    id,
    text,
    author: userCore?.name,
    screenName: userCore?.screen_name,
    createdAt,
    likes: tr.counts?.favorite_count ?? tr.legacy?.favorite_count ?? 0,
    retweets: tr.counts?.retweet_count ?? tr.legacy?.retweet_count ?? 0,
    replies: tr.counts?.reply_count ?? tr.legacy?.reply_count ?? 0,
    quotes: tr.counts?.quote_count ?? tr.legacy?.quote_count ?? 0,
    bookmarks: tr.counts?.bookmark_count ?? tr.legacy?.bookmark_count ?? 0,
    views: tr.views?.count,
    links,
    url: `https://x.com/${screenName}/status/${id}`
  };
}

function extractTweetsFromInstructions(instructions) {
  const tweets = [];
  for (const inst of instructions || []) {
    for (const e of inst.entries || []) {
      const directContent = e.content?.itemContent || e.content?.content;
      const normalized = normalizeTweetResult(directContent?.tweet_results?.result);
      if (normalized) {
        tweets.push(normalized);
        continue;
      }
      for (const item of e.content?.items || []) {
        const subContent = item?.item?.itemContent || item?.item?.content;
        const sub = normalizeTweetResult(subContent?.tweet_results?.result);
        if (sub) tweets.push(sub);
      }
    }
  }
  return tweets;
}

async function _fetchApiGraphQL(client, queryId, opName, variables, actionName) {
  const apiPath = `/graphql/${queryId}/${opName}`;
  const headers = await client._getHeaders('GET', apiPath, true);
  const fullPath = `${apiPath}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const res = await client._getApiGraphQL(fullPath, headers, opName);
  return client._parseGraphQL(res, actionName);
}

async function getProfile(client, screenName) {
  const cleanName = String(screenName).replace(/^@/, '');
  const queryId = client.queryIds.UserByScreenNameWeb || client.queryIds.UserByScreenName;
  const data = await _fetchApiGraphQL(
    client,
    queryId,
    'UserByScreenName',
    {
      screenName: cleanName,
      withIdentity: true,
      __relay_internal__pv__xclientsfeaturesappviewercansendmoneyrelayprovider: false,
      __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true
    },
    'getProfile'
  );

  const result = data.data?.user_result_by_screen_name?.result || data.data?.user?.result;
  return {
    id: result?.rest_id,
    name: result?.core?.name,
    screenName: result?.core?.screen_name || cleanName,
    bio: result?.profile_bio?.description,
    followersCount: result?.relationship_counts?.followers,
    followingCount: result?.relationship_counts?.following,
    tweetsCount: result?.tweet_counts?.tweets,
    mediaCount: result?.tweet_counts?.media_tweets,
    avatar: result?.avatar?.image_url,
    banner: result?.banner?.image_url,
    isBlueVerified: result?.verification?.is_blue_verified ?? result?.is_blue_verified,
    website: result?.profile_bio?.entities?.url?.urls?.[0]?.expanded_url || result?.website?.url,
    raw: result
  };
}

async function getUserTweets(client, screenName, count = 20, cursor = null) {
  const cleanName = String(screenName).replace(/^@/, '');
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.UserOriginalsTimeline,
    'UserOriginalsTimeline',
    {
      screenName: cleanName,
      count,
      cursor,
      sortByMostLiked: null,
      ...X_WEB_RELAY_DEFAULTS
    },
    'getUserTweets'
  );

  const instructions =
    json.data?.user_result_by_screen_name?.result?.profile_user_originals_timeline?.timeline?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

async function getUserReposts(client, screenName, count = 20, cursor = null) {
  const cleanName = String(screenName).replace(/^@/, '');
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.UserRepostsTimeline,
    'UserRepostsTimeline',
    {
      screenName: cleanName,
      count,
      cursor,
      ...X_WEB_RELAY_DEFAULTS
    },
    'getUserReposts'
  );

  const instructions =
    json.data?.user_result_by_screen_name?.result?.profile_user_reposts_timeline?.timeline?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

async function searchTweets(client, query, count = 20, product = 'Latest', cursor = null) {
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.SearchByRawQuery,
    'SearchByRawQuery',
    {
      rawQuery: query,
      product,
      querySource: 'typed_query',
      count,
      cursor,
      withMediaGridTweet: false,
      ...X_WEB_RELAY_DEFAULTS
    },
    'searchTweets'
  );

  const instructions = json.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

async function getHomeTimeline(client, count = 20, cursor = null) {
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.HomeTimeline,
    'HomeTimeline',
    {
      count,
      cursor,
      requestContext: null,
      seenTweetIds: null,
      tag: null,
      topicIds: null,
      ...X_WEB_RELAY_DEFAULTS
    },
    'getHomeTimeline'
  );

  const instructions = json.data?.home_timeline?.home_timeline_urt?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

async function getExplore(client, count = 20, cursor = null, timelineId = null) {
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.ExploreTimeline,
    'genericTimelineQuery',
    {
      timelineId: timelineId || DEFAULT_EXPLORE_TIMELINE_ID,
      count,
      cursor,
      ...X_WEB_RELAY_DEFAULTS
    },
    'getExplore'
  );

  const instructions = json.data?.timeline?.timeline?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

function extractTweetId(tweetIdOrUrl) {
  const input = String(tweetIdOrUrl || '').trim();
  const match = input.match(/status\/(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input)) return input;
  throw new Error(`Invalid tweet ID or URL: ${tweetIdOrUrl}`);
}

async function getTweet(client, tweetIdOrUrl) {
  const restId = extractTweetId(tweetIdOrUrl);
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.TweetResultByRestId,
    'TweetResultByRestId',
    {
      restId,
      withFocalTweet: true,
      ...X_WEB_RELAY_DEFAULTS
    },
    'getTweet'
  );

  const raw = json.data?.tweet_result_by_rest_id?.result;
  return normalizeTweetResult(raw) || { id: restId, raw };
}

async function getNotifications(client, count = 40, timelineType = 'All', cursor = null) {
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.NotificationsQuery,
    'notificationsQuery',
    {
      timelineType,
      count,
      cursor,
      ...X_WEB_RELAY_DEFAULTS
    },
    'getNotifications'
  );

  const instructions =
    json.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline?.instructions || [];
  const items = [];
  for (const inst of instructions) {
    for (const e of inst.entries || []) {
      const ic = e.content?.itemContent || e.content?.content;
      if (!ic) continue;
      items.push({
        id: e.entryId || e.entry_id,
        type: ic.__typename,
        message: ic.rich_message?.text || ic.message?.text,
        tweet: normalizeTweetResult(ic.tweet_results?.result) || undefined
      });
    }
  }
  return items;
}

async function searchTypeahead(client, query) {
  const q = String(query);
  const json = await _fetchApiGraphQL(
    client,
    client.queryIds.GlobalSearchTypeahead,
    'globalSearchTypeaheadQuery',
    {
      query: q,
      cashtagQuery: q,
      withCashtag: false,
      __relay_internal__pv__typeaheadsportsenabledrelayprovider: true,
      __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true
    },
    'searchTypeahead'
  );

  const items = json.data?.viewer?.search_search_by_raw_query?.global_search_typeahead?.items || [];
  return items.map((item) => ({
    type: item.__typename,
    query: item.query,
    user: item.user_results?.result?.core
      ? {
          id: item.user_results.result.rest_id,
          name: item.user_results.result.core.name,
          screenName: item.user_results.result.core.screen_name
        }
      : undefined
  }));
}

async function getBadgeCounts(client) {
  const apiPath = '/2/badge_count/badge_count.json?supports_ntab_urt=1&include_xchat_count=1';
  const headers = await client._getHeaders('GET', apiPath, true);
  const res = await client._getApiGraphQL(apiPath, headers);
  return client._parseGraphQL(res, 'getBadgeCounts');
}

module.exports = {
  extractTweetId,
  normalizeTweetResult,
  extractTweetsFromInstructions,
  getProfile,
  getUserTweets,
  getUserReposts,
  searchTweets,
  getHomeTimeline,
  getExplore,
  getTweet,
  getNotifications,
  searchTypeahead,
  getBadgeCounts
};
