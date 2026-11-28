const { PROFILE_READ_FEATURES, TIMELINE_READ_FEATURES } = require('../constants');

function extractTweetsFromInstructions(instructions) {
  const tweets = [];
  for (const inst of instructions || []) {
    for (const e of inst.entries || []) {
      const tr = e.content?.itemContent?.tweet_results?.result;
      if (tr?.legacy) {
        tweets.push({
          id: tr.rest_id,
          text: tr.legacy.full_text,
          createdAt: tr.legacy.created_at,
          likes: tr.legacy.favorite_count,
          retweets: tr.legacy.retweet_count,
          replies: tr.legacy.reply_count,
          views: tr.views?.count,
          url: `https://x.com/i/status/${tr.rest_id}`
        });
      }
    }
  }
  return tweets;
}

async function getProfile(client, screenName) {
  const cleanName = String(screenName).replace(/^@/, '');
  const queryId = client.queryIds.UserByScreenName;
  const apiPath = `/i/api/graphql/${queryId}/UserByScreenName`;
  const headers = await client._getHeaders('GET', apiPath);

  const variables = JSON.stringify({ screen_name: cleanName, withSafetyModeUserFields: true });
  const features = JSON.stringify(PROFILE_READ_FEATURES);

  const fullPath = `${apiPath}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const res = await client._getGraphQL(fullPath, headers);
  const data = client._parseGraphQL(res, 'getProfile');

  const result = data.data?.user?.result;
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
    isBlueVerified: result?.is_blue_verified,
    website: result?.website?.url,
    raw: result
  };
}

async function getUserTweets(client, screenNameOrUserId, count = 20) {
  let userId = screenNameOrUserId;
  if (isNaN(screenNameOrUserId)) {
    const profile = await getProfile(client, screenNameOrUserId);
    userId = profile.id;
  }

  const queryId = client.queryIds.UserTweetsAndReplies;
  const apiPath = `/i/api/graphql/${queryId}/UserTweetsAndReplies`;
  const headers = await client._getHeaders('GET', apiPath);

  const variables = JSON.stringify({
    userId: String(userId),
    count,
    includePromotedContent: false,
    withCommunity: true,
    withVoice: true
  });
  const features = JSON.stringify(TIMELINE_READ_FEATURES);

  const fullPath = `${apiPath}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const res = await client._getGraphQL(fullPath, headers);
  const json = client._parseGraphQL(res, 'getUserTweets');

  const result = json.data?.user?.result;
  const instructions = (result?.timeline?.timeline || result?.timeline_v2?.timeline)?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

async function searchTweets(client, query, count = 20, product = 'Latest') {
  const queryId = client.queryIds.SearchTimeline;
  const apiPath = `/i/api/graphql/${queryId}/SearchTimeline`;
  const headers = await client._getHeaders('GET', apiPath);

  const variables = JSON.stringify({
    rawQuery: query,
    count,
    querySource: 'typed_query',
    product
  });
  const features = JSON.stringify(TIMELINE_READ_FEATURES);

  const fullPath = `${apiPath}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const res = await client._getGraphQL(fullPath, headers);
  const json = client._parseGraphQL(res, 'searchTweets');

  const instructions = json.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
  return extractTweetsFromInstructions(instructions);
}

module.exports = {
  getProfile,
  getUserTweets,
  searchTweets
};
