import { defineAccountModel }      from './Account.js';
import { definePostModel }         from './Post.js';
import { defineScraperRunModel }   from './ScraperRun.js';
import { defineUserContextModel }  from './UserContext.js';
import { defineProjectModel }      from './Project.js';
import { defineGithubEventModel }  from './GithubEvent.js';
import { defineLinkedinPostModel } from './LinkedinPost.js';

/**
 * Register all Sequelize models and declare associations.
 * Call once after database.connect() resolves.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {{ Account, Post, ScraperRun, UserContext, Project, GithubEvent, LinkedinPost }}
 */
export function registerModels(sequelize) {
  const Account      = defineAccountModel(sequelize);
  const Post         = definePostModel(sequelize);
  const ScraperRun   = defineScraperRunModel(sequelize);
  const UserContext  = defineUserContextModel(sequelize);
  const Project      = defineProjectModel(sequelize);
  const GithubEvent  = defineGithubEventModel(sequelize);
  const LinkedinPost = defineLinkedinPostModel(sequelize);

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

  Account.hasMany(LinkedinPost, {
    foreignKey: 'account_id',
    as:         'linkedinPosts',
    onDelete:   'CASCADE',
  });
  LinkedinPost.belongsTo(Account, {
    foreignKey: 'account_id',
    as:         'account',
  });

  // UserContext and Project have no associations — standalone stores.

  return { Account, Post, ScraperRun, UserContext, Project, GithubEvent, LinkedinPost };
}