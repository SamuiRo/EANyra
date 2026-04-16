import { defineAccountModel }  from './Account.js';
import { definePostModel }     from './Post.js';
import { defineSignalModel }   from './Signal.js';
import { defineScraperRunModel }  from './ScraperRun.js';
import { defineUserContextModel } from './UserContext.js';
import { defineProjectModel }     from './Project.js';

/**
 * Register all Sequelize models and declare associations.
 * Call once after database.connect() resolves.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {{ Account, Post, Signal, ScraperRun, UserContext, Project }}
 */
export function registerModels(sequelize) {
  const Account     = defineAccountModel(sequelize);
  const Post        = definePostModel(sequelize);
  const Signal      = defineSignalModel(sequelize);
  const ScraperRun  = defineScraperRunModel(sequelize);
  const UserContext = defineUserContextModel(sequelize);
  const Project     = defineProjectModel(sequelize);

  // ── Associations ──────────────────────────────────────────────────────────

  // One account → many posts (all platforms)
  Account.hasMany(Post, {
    foreignKey: 'account_id',
    as:         'posts',
    onDelete:   'CASCADE',
  });
  Post.belongsTo(Account, {
    foreignKey: 'account_id',
    as:         'account',
  });

  // One account → many signals (GitHub events, future sources)
  // account_id is nullable on Signal — manual signals have no account
  Account.hasMany(Signal, {
    foreignKey: 'account_id',
    as:         'signals',
    onDelete:   'CASCADE',
  });
  Signal.belongsTo(Account, {
    foreignKey: 'account_id',
    as:         'account',
  });

  // UserContext and Project are standalone — no associations needed

  return { Account, Post, Signal, ScraperRun, UserContext, Project };
}