export interface CachedUserProfilePermissionDto {
  userId: string;
  username: string;
  email: string;
  realm: {
    realmId: string;
    name: string;
  };
  roles: string[];
  permissions: string[];
}