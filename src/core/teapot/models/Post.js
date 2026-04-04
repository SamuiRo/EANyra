import { DataTypes } from 'sequelize';

/**
 * Post — a scraped tweet.
 *
 * Fields:
 *   id           – auto-increment PK
 *   tweet_id     – Twitter's own ID string (unique; prevents duplicates)
 *   account_id   – FK → Account
 *   text         – full post text
 *   lang         – detected language code (optional)
 *   posted_at    – original publication timestamp from Twitter
 *   likes        – like count at time of scrape
 *   retweets     – retweet count
 *   replies      – reply count
 *   views        – view/impression count (if available)
 *   media_urls   – JSON array of photo/video URLs (stringified)
 *   is_retweet   – true if this is a retweet (RT)
 *   is_reply     – true if this is a reply to another tweet
 *   raw_url      – direct URL to the tweet
 *   scraped_at   – when we captured this record
 */
export function definePostModel(sequelize) {
  return sequelize.define('Post', {
    id: {
      type:          DataTypes.INTEGER,
      primaryKey:    true,
      autoIncrement: true,
    },
    tweet_id: {
      type:      DataTypes.STRING(32),
      allowNull: false,
      unique:    true,
    },
    account_id: {
      type:      DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'accounts', key: 'id' },
      onDelete:   'CASCADE',
    },
    text: {
      type:      DataTypes.TEXT,
      allowNull: false,
    },
    lang: {
      type:      DataTypes.STRING(8),
      allowNull: true,
    },
    posted_at: {
      type:      DataTypes.DATE,
      allowNull: true,
    },
    likes: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    retweets: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    replies: {
      type:         DataTypes.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    },
    views: {
      type:         DataTypes.INTEGER,
      allowNull:    true,
    },
    // Stored as JSON string: ["https://...", ...]
    media_urls: {
      type:         DataTypes.TEXT,
      allowNull:    true,
      get() {
        const raw = this.getDataValue('media_urls');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
      },
      set(value) {
        this.setDataValue('media_urls', JSON.stringify(value ?? []));
      },
    },
    is_retweet: {
      type:         DataTypes.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    },
    is_reply: {
      type:         DataTypes.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    },
    raw_url: {
      type:      DataTypes.STRING(256),
      allowNull: true,
    },
    scraped_at: {
      type:         DataTypes.DATE,
      allowNull:    false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName:   'posts',
    timestamps:  true,
    underscored: true,
    indexes: [
      { fields: ['account_id'] },
      { fields: ['posted_at'] },
      { fields: ['scraped_at'] },
    ],
  });
}