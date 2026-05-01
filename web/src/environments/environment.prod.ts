// Values are injected by Amplify build environment variables.
// After `sam deploy`, copy the stack outputs into the Amplify console
// (App settings → Environment variables) with these exact names:
//   ANGULAR_API_BASE_URL, ANGULAR_WS_URL,
//   ANGULAR_COGNITO_USER_POOL_ID, ANGULAR_COGNITO_CLIENT_ID,
//   ANGULAR_REGION, ANGULAR_SUMMITS_URL
export const environment = {
  production: true,
  apiBaseUrl: '${ANGULAR_API_BASE_URL}',
  wsUrl: '${ANGULAR_WS_URL}',
  cognitoUserPoolId: '${ANGULAR_COGNITO_USER_POOL_ID}',
  cognitoClientId: '${ANGULAR_COGNITO_CLIENT_ID}',
  region: '${ANGULAR_REGION}',
  // Direct S3 URL for worldwide summits GeoJSON (bypasses Lambda 6MB limit)
  summitsUrl: '${ANGULAR_SUMMITS_URL}',
};
