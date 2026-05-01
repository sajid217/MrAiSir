# Security Specification - Qubic Ai

## 1. Data Invariants
- A **Chat** must have a `userId` that matches the creator's UID.
- A **Chat** must have `createdAt`, `updatedAt`, and `model` fields.
- A **Message** must belong to a **Chat** owned by the same user.
- **Messages** are immutable once created, except for `model` responses which can be updated (for streaming).
- **Chats** can only have their `title` and `updatedAt` updated by the owner.

## 2. The "Dirty Dozen" Payloads (Denial Tests)

### Attempt 1: Identity Spoofing (Chat)
Create a chat for another user.
```json
{
  "userId": "SOMEONE_ELSE_UID",
  "title": "Stolen Chat",
  "createdAt": "SERVER_TIMESTAMP"
}
```
**Expected: PERMISSION_DENIED**

### Attempt 2: Privilege Escalation (Chat)
Update someone else's chat title.
`PATCH /chats/OTHER_USER_CHAT_ID`
```json
{
  "title": "I am Admin now"
}
```
**Expected: PERMISSION_DENIED**

### Attempt 3: Orphaned Write (Message)
Create a message in a chat you don't own.
`POST /chats/OTHER_USER_CHAT_ID/messages`
```json
{
  "role": "user",
  "content": "Hello",
  "createdAt": "SERVER_TIMESTAMP"
}
```
**Expected: PERMISSION_DENIED**

### Attempt 4: State Corruption (Message)
Update a user message (should be immutable).
`PATCH /chats/MY_CHAT_ID/messages/MY_MSG_ID`
```json
{
  "content": "Changed my mind"
}
```
**Expected: PERMISSION_DENIED**

### Attempt 5: ID Poisoning
Create a chat with a massive string as ID.
`POST /chats/VERY_LONG_GARBAGE_STRING_ID...`
**Expected: PERMISSION_DENIED**

### Attempt 6: Shadow Update
Add a forbidden field to a chat.
```json
{
  "title": "New Title",
  "isAdminChat": true
}
```
**Expected: PERMISSION_DENIED**

### Attempt 7: Timestamp Spoofing
Use a client-side timestamp instead of server timestamp.
```json
{
  "updatedAt": "2023-01-01T00:00:00Z"
}
```
**Expected: PERMISSION_DENIED**

### Attempt 8: Type Mismatch
Send a number for the title.
```json
{
  "title": 12345
}
```
**Expected: PERMISSION_DENIED**

### Attempt 9: Resource Exhaustion (Denial of Wallet)
Send a 2MB message content.
**Expected: PERMISSION_DENIED**

### Attempt 10: Anonymous Read
Read chats without being signed in.
**Expected: PERMISSION_DENIED**

### Attempt 11: Email Verification Bypass
Sign in but with an unverified email (if enforced).
**Expected: PERMISSION_DENIED**

### Attempt 12: Cross-Relational Update
Try to move a message from Chat A to Chat B.
**Expected: PERMISSION_DENIED**

## 3. Test Runner (Conceptual)
All the above must return `PERMISSION_DENIED` in a simulated local environment.
