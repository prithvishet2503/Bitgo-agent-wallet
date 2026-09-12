import { db, type User } from '../../store/db.js';
import type { BaseDao } from '../base.dao.js';

/**
 * Hand-rolled rather than a plain `InMemoryDao<User>` because users are also
 * looked up by API token (`db.usersByToken`) - the two maps must stay in sync,
 * the same reason wallet-platform and UMS give some entities a
 * `*RepositoryCustom.ts`/`*RepositoryImpl.ts` alongside the generated
 * Spring-Data repository instead of relying on the generic one.
 */
export const userDao: BaseDao<User> & { getByToken(token: string): User | undefined } = {
  get(id) {
    return db.users.get(id);
  },
  list(predicate) {
    const all = [...db.users.values()];
    return predicate ? all.filter(predicate) : all;
  },
  createOrUpdate(user) {
    db.users.set(user.id, user);
    db.usersByToken.set(user.apiToken, user);
    return user;
  },
  delete(id) {
    const user = db.users.get(id);
    if (!user) return false;
    db.usersByToken.delete(user.apiToken);
    return db.users.delete(id);
  },
  getByToken(token) {
    return db.usersByToken.get(token);
  },
};
