# LINE Group Mention Notification Guide

This note records the working method for notifying a specific person inside a LINE group from an AM project.

Use this when AM needs to send a follow-up message to a group owner, project owner, task owner, or responsible person inside a LINE group and wants LINE to trigger a real mention notification.

## When To Use

Use group mention notifications when:

- The target conversation is a LINE group or room.
- The responsible person has a known LINE `userId`.
- The message should notify that person directly inside the shared project group.
- The notification is for a confirmed or approved follow-up, not an unconfirmed candidate.

Typical AM use cases:

- Follow up with a project owner in the project LINE group.
- Notify the responsible person after Seven approves a follow-up message.
- Remind a group member about a due task, missing reply, blocker, or next action.
- Notify Seven inside a project group when a counterpart has replied with an important time or decision.

## Required Format

To create a real LINE mention, use `textV2` with `substitution`.

Do not use plain `text` with literal `@Name`.

Working payload shape:

```json
{
  "to": "GROUP_OR_ROOM_ID",
  "messages": [
    {
      "type": "textV2",
      "text": "{owner} 提醒：請協助確認這項任務的下一步。",
      "substitution": {
        "owner": {
          "type": "mention",
          "mentionee": {
            "type": "user",
            "userId": "TARGET_LINE_USER_ID"
          }
        }
      }
    }
  ]
}
```

`{owner}` is a placeholder in `text`. LINE replaces it with a real mention using the `substitution.owner` object.

## Important Rules

- Mention notifications only work when the destination is a LINE group or room.
- Mentions do not work in one-on-one user chats. LINE rejects those with: `Mentions are only supported when the destination is a group or room.`
- The target user must be a member of the destination group or room.
- The `userId` must be the real LINE user ID, not a display name.
- The placeholder name can be any key, such as `{owner}`, `{seven}`, or `{andy}`, but the same key must exist under `substitution`.
- Keep the final message human-readable after substitution.

## What Not To Use

Do not send this and expect a real mention:

```json
{
  "type": "text",
  "text": "@Andy Tsai 了解，謝謝。",
  "mention": {
    "mentionees": [
      {
        "index": 0,
        "length": 10,
        "userId": "TARGET_LINE_USER_ID"
      }
    ]
  }
}
```

That format is not the correct outbound mention method. It may be accepted by an internal wrapper but LINE will display it as plain text, such as `@Andy Tsai`, without triggering a real mention.

## Confirmed SevenAM Test

Date: 2026-06-10

Destination: `Andy & Seven` LINE group

Mentioned user: Seven 陳聖文

Successful textV2 message:

```json
{
  "type": "textV2",
  "text": "{seven} 提醒：Andy 明天下午 1 點會到公司找你。",
  "substitution": {
    "seven": {
      "type": "mention",
      "mentionee": {
        "type": "user",
        "userId": "U09dc6553016c78d89c515522be9b74f6"
      }
    }
  }
}
```

Result: LINE displayed a real mention and notified Seven in the group.

## AM Implementation Pattern

When sending an approved follow-up to a group owner:

1. Resolve the LINE group or room from the task/project conversation.
2. Resolve the target member from the group member table or recent LINE messages.
3. Confirm that the member belongs to that group or room.
4. Build a `textV2` message with a placeholder, such as `{owner}`.
5. Put the mention object under `substitution.owner`.
6. Send the message to the group or room ID.
7. Record the outgoing message and the mentioned user in Notion.

If the member cannot be resolved uniquely, do not guess. Mark the item as needing target confirmation.

If the destination is a one-on-one user chat, use a normal text message instead of mention.

