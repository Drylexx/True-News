# Security Specification - True News

## Data Invariants
1. A NewsItem must have a valid `authorId` that matches the authenticated user.
2. NewsItems can be created by any authenticated user.
3. NewsItems can only be deleted or updated by their original author.
4. Chat messages must be isolated per user.
5. All IDs must follow a strict pattern.
6. All strings must have size limits to prevent resource exhaustion.

## The "Dirty Dozen" Payloads (Attacks)
1. **Identity Spoofing**: Create a NewsItem with `authorId` of someone else.
2. **Ghost Field Injection**: Create a NewsItem with a secret field `isAdmin: true`.
3. **Resource Exhaustion**: Send a 2MB string as `content`.
4. **Orphaned Writes**: Update a news item after the user's account is theoretically "deleted" (simulated by access control).
5. **Path ID Poisoning**: Attempt to write to `/news/../../some_other_collection`.
6. **Unauthorized Deletion**: User B tries to delete User A's news.
7. **Unauthorized Update**: User B tries to modify User A's news content.
8. **PII Leak**: Attempt to list all chats of all users.
9. **Timestamp Manipulation**: Set `createdAt` to a future date manually.
10. **Partial Update Gap**: Attempt to update `authorId` during a content update.
11. **Type Poisoning**: Send an array instead of a string for `title`.
12. **Anonymous Escalation**: Anonymous user trying to access non-anonymous features (if any).

## The Test Runner
(I would write `firestore.rules.test.ts` if I had a test runner environment, but I will simulate the logic in my audit).
