import { defineAccountModel }     from './Account.js';
import { definePostModel }        from './Post.js';
import { defineScraperRunModel }  from './ScraperRun.js';
import { defineUserContextModel } from './UserContext.js';
import { defineProjectModel }     from './Project.js';
import { defineGithubEventModel } from './GithubEvent.js';

/**
 * Register all Sequelize models and declare associations.
 * Call once after database.connect() resolves.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {{ Account, Post, ScraperRun, UserContext, Project, GithubEvent }}
 */
export function registerModels(sequelize) {
  const Account      = defineAccountModel(sequelize);
  const Post         = definePostModel(sequelize);
  const ScraperRun   = defineScraperRunModel(sequelize);
  const UserContext  = defineUserContextModel(sequelize);
  const Project      = defineProjectModel(sequelize);
  const GithubEvent  = defineGithubEventModel(sequelize);

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

  Account.hasMany(GithubEvent, {
    foreignKey: 'account_id',
    as:         'githubEvents',
    onDelete:   'CASCADE',
  });

  GithubEvent.belongsTo(Account, {
    foreignKey: 'account_id',
    as:         'account',
  });

  // UserContext and Project have no associations — standalone stores.

  return { Account, Post, ScraperRun, UserContext, Project, GithubEvent };
}