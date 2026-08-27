# Profile Card App (Next.js + Cognito, all-AWS)

A static profile-card frontend (`public/index.html` + `public/app.js`) backed
by a Cognito-authenticated API that persists photos to **S3** and profile /
journal fields to **MongoDB**. Two interchangeable ways to run the API:

1. **Next.js API route** (`pages/api/save-profile.js`) — the deployed path,
   running as a container on **ECS Fargate** behind an Application Load
   Balancer.
2. **AWS Lambda** (`lambda/save-profile-handler.js`) behind **API Gateway** —
   same logic, same request/response shape, for a Lambda-first deployment.

Both paths require a valid **Amazon Cognito** access token on every request;
unauthenticated requests get `401`.

## Runtime

| | Version |
|---|---|
| Node.js | 26 (see `.nvmrc`; `engines` allows >= 20.19) |
| Next.js | 16 (Pages Router, Turbopack) |
| React | 19 |
| MongoDB driver | 7 |

`npm audit` is clean, and CI fails on any new high/critical advisory.

> **Security note:** an earlier version of this repo had real AWS access keys
> committed in comments in `save-profile.js` and `env_local.example`. Both are
> removed from the working tree, but **they remain in git history** — treat
> key `AKIASRDLQKZEHLEVDWNB` as burned. It has since been **deactivated**; it
> should also be **deleted** outright once nothing is found to depend on it.

---

## Architecture

```
index.html ── config.js (Cognito pool/client IDs, API base URL)
           ── cognito-auth.js (sign in/out, holds tokens in sessionStorage)
           ── app.js (sends Authorization: Bearer <access token> on every save)
                 │
                 ▼
      pages/api/save-profile.js   (ECS Fargate, behind an ALB)
                 OR
      lambda/save-profile-handler.js   (API Gateway + Lambda)
                 │
                 ├── verifies token against Cognito User Pool (aws-jwt-verify)
                 ├── S3.PutObject          → cover/avatar photos
                 └── MongoDB insertOne     → profile/journal record (carries
                                              Cognito `sub` as userId)
```

The frontend is served by the same container as the API (`public/` is copied
into the image), so `apiBaseUrl` in `public/config.js` is `''` — same origin,
no cross-origin preflight in the deployed setup.

## Repo layout

```
public/index.html, app.js, config.js, cognito-auth.js   ← static frontend
pages/api/save-profile.js                               ← Next.js API route
pages/api/health.js                                     ← ALB health probe
lib/verifyCognitoToken.js                               ← shared JWT check
lib/mongo.js                                            ← shared Mongo accessor
lambda/save-profile-handler.js                          ← Lambda version
lambda/test-save-profile-handler.js                     ← Lambda unit test
Dockerfile, .dockerignore                               ← container build
ecs/task-definition.json                                ← Fargate task def
aws/*.json, aws/README.md                               ← scoped IAM policies
.github/workflows/ci.yml                                ← tests on push
env_local.example                                       ← copy to .env.local
```

---

## 1. Amazon Cognito (auth)

1. Cognito → *Create user pool* → sign-in with email.
2. App integration → *Create app client* → **public client, no secret**, and
   under "Authentication flows" enable **`ALLOW_USER_PASSWORD_AUTH`** and
   **`ALLOW_REFRESH_TOKEN_AUTH`** (`cognito-auth.js` needs both — sign-in
   fails with `InvalidParameterException` if `USER_PASSWORD_AUTH` is missing).
3. Copy the **User pool ID** and **App client ID** into `public/config.js` and
   into `.env.local` as `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID`.

`cognito-auth.js` talks to Cognito directly over HTTPS (no SDK), exposing
`window.CognitoAuth.{signUp, confirmSignUp, signIn, signOut, refresh,
isSignedIn, getAccessToken, getIdToken}`.

## 2. IAM (execution permissions)

Whatever runs the API — the ECS **task role**, or the Lambda execution role —
needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:<region>:<account-id>:log-group:*"
    }
  ]
}
```

MongoDB needs no IAM — it is reached over the VPC on port 27017, restricted by
security group to the task's security group only. The **execution role**
(distinct from the task role) additionally needs `ssm:GetParameters` +
`kms:Decrypt` for the `MONGODB_URI` SecureString it injects.

The scoped policies used to administer this project from the CLI live in
`aws/` — see `aws/README.md`.

## 3. Storage

**S3** (photos):
```bash
aws s3 mb s3://your-bucket-name --region us-west-1
```

**MongoDB** runs on a small EC2 instance inside the VPC (chosen over
DocumentDB on cost). The connection string is stored as an SSM Parameter Store
**SecureString** at `/cluster-app/mongodb-uri` and injected into the container
by the task definition's `secrets` block — it is never in the image, the repo,
or an environment variable in plaintext.

Its security group allows `27017` **only** from the ECS task security group;
the instance has no public ingress and is administered over **SSM Session
Manager** (no SSH, no key pair). Daily EBS snapshots are handled by a DLM
lifecycle policy with 7-day retention.

## 4. Deploy: container → ECR → ECS Fargate

```bash
REPO=<account-id>.dkr.ecr.us-west-1.amazonaws.com/cluster-app

aws ecr get-login-password --region us-west-1 \
  | docker login --username AWS --password-stdin "$REPO"

docker build --platform linux/amd64 -t "${REPO}:latest" .
docker push "${REPO}:latest"

aws ecs update-service --cluster cluster-app --service cluster-app \
  --force-new-deployment --region us-west-1
```

Concrete values (roles, image, Cognito IDs, log group, the SSM secret ARN) are
in `ecs/task-definition.json`. Register a new revision after editing it:

```bash
aws ecs register-task-definition --cli-input-json file://ecs/task-definition.json
```

**Two things that will bite you**, both already handled in the Dockerfile:

- Next's standalone server binds to `$HOSTNAME`, and **ECS injects its own
  `HOSTNAME`** into every container, overriding any `ENV` in the image. Left
  alone, the server binds only to the task's ENI address: the ALB can reach it
  but `127.0.0.1` inside the container cannot, so the *container* health check
  fails and ECS kills the task after a couple of minutes — even while the ALB
  target reports healthy. The `CMD` sets `HOSTNAME=0.0.0.0` at exec time,
  which is the one place ECS cannot override.
- The container health check must use `127.0.0.1`, not `localhost`, which
  resolves to IPv6 `::1` while Next listens on IPv4.

## 5. AWS Lambda + API Gateway (alternative)

`lambda/save-profile-handler.js` is a drop-in Lambda version of the API route
— same env vars, same S3/MongoDB calls, same Cognito check, speaking API
Gateway's Lambda-proxy event/response shape instead of Next.js's `req`/`res`.

1. Lambda → *Create function* → Node.js 22.x or later → attach the role above.
2. `zip -r function.zip lambda lib node_modules` from the repo root and upload.
3. Handler: `lambda/save-profile-handler.handler`.
4. Env vars: `AWS_REGION`, `S3_BUCKET`, `MONGODB_URI`, `MONGODB_DB`,
   `ALLOWED_ORIGIN`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`.
5. API Gateway → **HTTP API** → route `POST /api/save-profile` (plus
   `OPTIONS` for the preflight, or API Gateway's built-in CORS — not both, to
   avoid duplicate headers).
6. Point `apiBaseUrl` in `public/config.js` at the invoke URL.

The function must be attached to the VPC to reach MongoDB.

**Test the handler locally, no AWS needed:**
```bash
npm run test:lambda
```
Plain Node with `assert`, no test framework. Mocks Cognito verification and
the AWS SDK clients, and checks: OPTIONS preflight → 204, missing/invalid
token → 401, valid token + body → 200 with `{ ok, savedAt, coverUrl,
avatarUrl }`, persisted document carries the Cognito `sub`, wrong method → 405.

## Local setup

```bash
nvm use            # Node 26, per .nvmrc
npm ci
cp env_local.example .env.local
# fill in .env.local: region, bucket, MONGODB_URI, ALLOWED_ORIGIN, Cognito IDs
npm run dev
```

A throwaway local database:
```bash
docker run -d -p 27017:27017 mongo:7
```

Set `apiBaseUrl` in `public/config.js` to `http://localhost:3000` for local
testing (it is `''` in the deployed setup, which is same-origin).

## Request / response shape

```json
// POST /api/save-profile
// Headers: Authorization: Bearer <Cognito access token>
{
  "profile": { "fullName": "...", "email": "...", "title": "...", "ethnicity": "...", "religion": "...", "city": "...", "political": "..." },
  "photos": { "cover": "data:image/jpeg;base64,...", "avatar": "data:image/png;base64,..." },
  "journal": "Today I..."
}
```
```json
{ "ok": true, "savedAt": "2026-08-19T21:49:00.000Z", "coverUrl": "https://...", "avatarUrl": "https://..." }
```
`401 { "ok": false, "error": "Unauthorized" }` if the token is missing,
expired, or fails verification against the User Pool.

## Notes

- **CORS**: `ALLOWED_ORIGIN` must be an *exact* origin (not `*`) whenever the
  API is called cross-origin, because requests carry an `Authorization`
  header. In the deployed setup the frontend is same-origin, so this only
  matters for local dev and the Lambda path.
- Presigned S3 URLs expire after 7 days; put CloudFront + origin access
  control in front of the bucket if you need permanent links.
- Documents include `userId` (the Cognito `sub`) alongside a generated `id`,
  so you can query/upsert per user later even though each save currently
  writes a new document.
- `lib/mongo.js` caches the connection **promise**, not the resolved client —
  so concurrent requests arriving during the initial handshake share one
  connection attempt instead of each opening their own, which is how a small
  Mongo host ends up refusing connections under load.
- `ethnicity`, `religion`, and `political` are collected as free-text profile
  fields and stored as entered — if this app is used beyond a personal /
  portfolio context, treat that as sensitive personal data subject to whatever
  privacy rules apply where your users are (e.g. GDPR special-category data),
  and consider making those fields optional.
