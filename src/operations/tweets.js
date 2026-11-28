const { TWEET_WRITE_FEATURES } = require('../constants');

async function createTweet(client, text, options = {}) {
  const queryId = client.queryIds.CreateTweet;
  const apiPath = `/i/api/graphql/${queryId}/CreateTweet`;
  const headers = await client._getHeaders('POST', apiPath);

  const payload = JSON.stringify({
    variables: {
      tweet_text: text,
      media: {
        media_entities: [],
        possibly_sensitive: false
      },
      semantic_annotation_ids: [],
      disallowed_reply_options: null,
      semantic_annotation_options: {
        source: 'UniversalLink'
      },
      ...options.variables
    },
    features: {
      ...TWEET_WRITE_FEATURES,
      ...options.features
    },
    queryId
  });

  const res = await client._postGraphQL(apiPath, headers, payload, 'CreateTweet');
  const data = client._parseGraphQL(res, 'createTweet');
  const tweetResult = data.data?.create_tweet?.tweet_results?.result || data.data?.create_tweet || {};
  const tweetId =
    tweetResult.rest_id || tweetResult.legacy?.id_str || tweetResult.edit_control?.edit_tweet_ids?.[0] || null;
  if (!tweetId) {
    const err = new Error(
      'CreateTweet returned HTTP 200 without a tweetId. Status is unknown — STOP and inspect X manually before retrying.'
    );
    err.halt = true;
    err.code = 'AMBIGUOUS_WRITE_RESULT';
    throw err;
  }
  const screenName = tweetResult.core?.user_results?.result?.core?.screen_name || 'i';

  return {
    tweetId,
    text: tweetResult.legacy?.full_text || text,
    createdAt: tweetResult.legacy?.created_at || new Date().toISOString(),
    url: `https://x.com/${screenName}/status/${tweetId}`,
    raw: tweetResult
  };
}

async function replyTweet(client, tweetId, text, options = {}) {
  return createTweet(client, text, {
    ...options,
    variables: {
      reply: {
        in_reply_to_tweet_id: String(tweetId),
        exclude_reply_user_ids: []
      },
      ...options.variables
    }
  });
}

async function postThread(client, tweets, delayMs = 0) {
  if (!Array.isArray(tweets) || tweets.length === 0) {
    throw new Error('postThread requires a non-empty array of tweet texts.');
  }

  if (typeof client.getRateLimitStatus === 'function') {
    const status = client.getRateLimitStatus();
    if (status.writesRemaining < tweets.length) {
      const err = new Error(
        `Insufficient write quota for ${tweets.length}-tweet thread (${status.writesRemaining} writes remaining in 60m window). Halting before publishing.`
      );
      err.code = 'RATE_LIMIT_EXCEEDED';
      err.halt = true;
      err.rateLimitExceeded = true;
      throw err;
    }
  }

  const published = [];
  let parentId = null;
  const hasLimiter = Boolean(client.rateLimiter);
  const originalStrict = hasLimiter ? client.rateLimiter.strict : false;

  try {
    for (let i = 0; i < tweets.length; i++) {
      // Honor strict mode before tweet #1, then let RateLimiter sleep 15-30s between tweets #2..N
      // so a confirmed thread never aborts mid-way due to PACING_WAIT_REQUIRED.
      if (i > 0 && hasLimiter) {
        client.rateLimiter.strict = false;
      }
      const res = parentId
        ? await replyTweet(client, parentId, tweets[i])
        : await createTweet(client, tweets[i]);
      published.push(res);
      parentId = res.tweetId;
      if (i < tweets.length - 1 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } catch (err) {
    err.published = published;
    throw err;
  } finally {
    if (hasLimiter) {
      client.rateLimiter.strict = originalStrict;
    }
  }
  return published;
}

async function deleteTweet(client, tweetId) {
  const queryId = client.queryIds.DeleteTweet;
  const apiPath = `/i/api/graphql/${queryId}/DeleteTweet`;
  const headers = await client._getHeaders('POST', apiPath);
  const payload = JSON.stringify({
    variables: { tweet_id: String(tweetId), dark_request: false },
    queryId
  });
  const res = await client._postGraphQL(apiPath, headers, payload);
  return client._parseGraphQL(res, 'deleteTweet');
}

async function favoriteTweet(client, tweetId) {
  const queryId = client.queryIds.FavoriteTweet;
  const apiPath = `/i/api/graphql/${queryId}/FavoriteTweet`;
  const headers = await client._getHeaders('POST', apiPath);
  const payload = JSON.stringify({
    variables: { tweet_id: String(tweetId) },
    queryId
  });
  const res = await client._postGraphQL(apiPath, headers, payload);
  return client._parseGraphQL(res, 'favoriteTweet');
}

async function retweet(client, tweetId) {
  const queryId = client.queryIds.CreateRetweet;
  const apiPath = `/i/api/graphql/${queryId}/CreateRetweet`;
  const headers = await client._getHeaders('POST', apiPath);
  const payload = JSON.stringify({
    variables: { tweet_id: String(tweetId), dark_request: false },
    queryId
  });
  const res = await client._postGraphQL(apiPath, headers, payload);
  return client._parseGraphQL(res, 'retweet');
}

module.exports = {
  createTweet,
  replyTweet,
  postThread,
  deleteTweet,
  favoriteTweet,
  retweet
};
