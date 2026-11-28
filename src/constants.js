const BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const API_X_HOST = 'api.x.com';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_EXPLORE_TIMELINE_ID = 'VGltZWxpbmU6DAC2CwABAAAAB2Zvcl95b3UAAA==';

const X_WEB_RELAY_DEFAULTS = {
  __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true,
  __relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider: true,
  __relay_internal__pv__replydownvoteenabledrelayprovider: false,
  __relay_internal__pv__postctafetchenabledrelayprovider: true,
  __relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider: true,
  __relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider: true,
  __relay_internal__pv__liveeventpostcontextenabledrelayprovider: true,
  __relay_internal__pv__xclientsfeaturestweetsportspostcontextenabledrelayprovider: true,
  __relay_internal__pv__timelineuserbioautotranslationrelayprovider: true
};

const DEFAULT_QUERY_IDS = {
  CreateTweet: 'wR5Z_lEibLvkew3tF9w-Sg',
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  UserByScreenName: 'AMIBMjtxEEATh4z8V9GtRg',
  UserByScreenNameWeb: 'Vs4wvILQLHuuofaxvQV6cA',
  UserOriginalsTimeline: 'AmKuSHqE8nVKyApBx2ZB8Q',
  UserRepostsTimeline: 'HFq4t1MffewIPWMZBcoomw',
  SearchByRawQuery: 'JO8RtNz_J5A3QZ5AsGktmg',
  HomeTimeline: 'cLqL-B9IUSFzJYVDQT03Ag',
  ExploreTimeline: 'xDfil0NbyvMRC7HhPsDxQA',
  TweetResultByRestId: '-GMof_5oJA0AyqlzZpJS2w',
  NotificationsQuery: 'L3HyjmrwBCEyGLEpBT1oQA',
  GlobalSearchTypeahead: 'qzTmbplKbPAC6zbDDAlWxQ',
  VerifiedFollowers: 'C6OVpqoet-2SFfRAKPN3yQ',
  FavoriteTweet: 'lI07N6Otwv1PhnEgXILM7A',
  CreateRetweet: 'mbRO74GrOvSfRcJnlMapnQ'
};

const TWEET_WRITE_FEATURES = {
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true
};

const TIMELINE_READ_FEATURES = {
  ...TWEET_WRITE_FEATURES,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  articles_preview_enabled: true
};

const PROFILE_READ_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true
};

module.exports = {
  BEARER_TOKEN,
  API_X_HOST,
  DEFAULT_USER_AGENT,
  DEFAULT_EXPLORE_TIMELINE_ID,
  X_WEB_RELAY_DEFAULTS,
  DEFAULT_QUERY_IDS,
  TWEET_WRITE_FEATURES,
  TIMELINE_READ_FEATURES,
  PROFILE_READ_FEATURES
};
