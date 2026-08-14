# Revision System Password Configuration

## Default Password
The default password for deleting revisions is: **987654321**

## How to Change the Password

### Option 1: Environment Variable (Recommended)
Add the following line to your `.env` file in the backend directory:

```
REVISION_DELETE_PASSWORD=your_new_password_here
```

Example `.env` file:
```
PORT=3001
MONGODB_URI=mongodb://localhost:27017
DATABASE_NAME=simorgh_db
REVISION_DELETE_PASSWORD=my_secure_password_123
```

### Option 2: Direct Code Change
If you prefer to change it directly in the code, edit `simorgh-backend/server.js`:

Find this line (around line 1130):
```javascript
const correctPassword = process.env.REVISION_DELETE_PASSWORD || '987654321';
```

And change `'987654321'` to your desired password.

## Security Notes
- The password is only required for **deleting** revisions
- Creating and viewing revisions does not require a password
- Old revisions (REV 0 - Base revision) cannot be deleted to preserve project history
- Only revisions created after REV 0 can be deleted with the password

## API Endpoints

### Create Revision
`POST /api/revisions`
- Body: `{ projectId, description?, projectSnapshot }`
- No authentication required

### Get Revisions
`GET /api/revisions/:projectId`
- Returns all revisions for a project
- No authentication required

### Load Revision
`GET /api/revisions/:revisionId/load`
- Loads project data from a specific revision
- No authentication required

### Delete Revision
`DELETE /api/revisions/:revisionId`
- Body: `{ password }`
- **Password required** - must match configured password
