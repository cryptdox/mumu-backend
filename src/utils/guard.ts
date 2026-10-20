import { authorizationMiddleware } from "../middlewares/authorization.middleware";
import { Resource, TypeAction, TypeResource } from "./consts";

/** Require `MU:<resource>:<action>:API_ENDPOINT` from the caller's IAM roles. */
export const guard = (resource: Resource, ...actions: TypeAction[]) =>
  authorizationMiddleware({ resource, actions, resourceType: TypeResource.API_ENDPOINT });

export { Resource as R, TypeAction as A };
