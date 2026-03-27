/**
 * orgErrors.js — Typed error classes for org operations.
 *
 * Using distinct name properties rather than instanceof checks allows these
 * errors to survive serialisation and CDI boundary crossings cleanly.
 */

export class OrgNotFoundError extends Error {
  constructor(orgId) {
    super(`Organisation not found: ${orgId}`);
    this.name = 'OrgNotFoundError';
  }
}

export class NotOrgAdminError extends Error {
  constructor(userId, orgId) {
    super(`User ${userId} is not an org-admin of organisation ${orgId}`);
    this.name = 'NotOrgAdminError';
  }
}

export class LastAdminError extends Error {
  constructor(orgId) {
    super(`Operation would leave organisation ${orgId} with no org-admin`);
    this.name = 'LastAdminError';
  }
}

export class AlreadyMemberError extends Error {
  constructor(userId, orgId) {
    super(`User ${userId} is already a member of organisation ${orgId}`);
    this.name = 'AlreadyMemberError';
  }
}

export class NotMemberError extends Error {
  constructor(userId, orgId) {
    super(`User ${userId} is not a member of organisation ${orgId}`);
    this.name = 'NotMemberError';
  }
}
