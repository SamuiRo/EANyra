import { defineAccountModel }    from './Account.js';
import { definePostModel }       from './Post.js';
import { defineScraperRunModel } from './ScraperRun.js';

/**
 * Register all Sequelize models and declare associations.
 * Call once after getDatabase() resolves.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {{ Account, Post, ScraperRun }}
 */
export function registerModels(sequelize) {
  const Account    = defineAccountModel(sequelize);
  const Post       = definePostModel(sequelize);
  const ScraperRun = defineScraperRunModel(sequelize);

  // ── Associations ──────────────────────────────────────────────────────────
  Account.hasMany(Post, {
    foreignKey: 'account_id',
    as:         'posts',
    onDelete:   'CASCADE',
  });

  Post.belongsTo(Account, {
    foreignKey: 'account_id',
    as:         'account',
  });

  return { Account, Post, ScraperRun };
}