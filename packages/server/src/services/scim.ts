/**
 * P6-02 (L13): SCIM 2.0 users, per decisions B: the workspace comes from the token only; filters
 * `userName eq` and `externalId eq`; PATCH in the Entra and Okta shapes; create links or makes a user
 * managed by this workspace; `active:false` disables the member (`disableMember`), `active:true` enables it;
 * DELETE disables or deletes per `tenants.settings.scim.onDelete`, the work moved or deleted per
 * `dataAction`. The owner cannot be touched; name and email change only for users this workspace manages.
 * Stub from C0: every method throws until L13.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';

/** a SCIM answer: the status and the `application/scim+json` body */
export interface ScimReply {
  status: number;
  body: DataObject;
}

export interface ScimListQuery {
  filter?: string;
  startIndex: number;
  count: number;
}

export class ScimService {
  constructor(readonly deps: ServiceDeps) {}

  async listUsers(_tenant: TenantRow, _query: ScimListQuery): Promise<ScimReply> {
    throw new Error('not implemented (L13)');
  }

  async getUser(_tenant: TenantRow, _id: string): Promise<ScimReply> {
    throw new Error('not implemented (L13)');
  }

  async createUser(_tenant: TenantRow, _body: DataObject): Promise<ScimReply> {
    throw new Error('not implemented (L13)');
  }

  async replaceUser(_tenant: TenantRow, _id: string, _body: DataObject): Promise<ScimReply> {
    throw new Error('not implemented (L13)');
  }

  async patchUser(_tenant: TenantRow, _id: string, _body: DataObject): Promise<ScimReply> {
    throw new Error('not implemented (L13)');
  }

  async deleteUser(_tenant: TenantRow, _id: string): Promise<ScimReply> {
    throw new Error('not implemented (L13)');
  }

  /** `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` */
  discovery(_kind: 'serviceProviderConfig' | 'resourceTypes' | 'schemas'): DataObject {
    throw new Error('not implemented (L13)');
  }
}
