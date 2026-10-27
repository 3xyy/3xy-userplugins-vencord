# RoleMembers

See who has which role in a server, and what each role can actually do, in one window.

## Opening it

Right-click a server icon, or click the server name at the top of the channel list, and pick **Role Members**. A wide window opens with three columns.

## The columns

**Roles.** The server owner is pinned at the top, then every role from highest to lowest, ending with @everyone. Each role shows its colour (gradient and holographic role styles too), its icon if it has one, and a member count.

**Permissions.** What the selected role, owner or member can do across the server. Each permission has a tick or a cross, and hovering the info icon shows Discord's own description of it. A role with Administrator gets every permission, the same way Discord treats it.

**Members.** Everyone who has the selected role. Click a member to see their combined permissions (all their roles plus @everyone) in the middle column, and click them again to go back to where you were. The profile button opens their Discord profile.

Drag the lines between the columns to resize them.

### Who has a permission

Click a permission to flip things around. The Roles column then lists every role that grants it, and the Members column lists everyone who has it, including the owner and anyone with an admin role. Click the permission again to go back.

### Searching

Each column has its own search box. The Members search looks across the whole server, not just the selected role: it asks Discord for members matching what you type and shows them as they come in.

## How members are loaded

Discord doesn't send your client every member of a big server; it loads them as they're needed. So when you select a role, RoleMembers asks Discord for that role's members. It's careful about it, because Discord rate limits these requests:

- It waits a moment after you click, so flicking through roles doesn't send a request for each one.
- It only asks once per role per Discord session.
- It never asks for @everyone, since that would mean requesting the entire server.

The count next to a role only counts members Discord has loaded so far, except for @everyone, which shows the server's total. When you pick a role, its full list loads and the count catches up. When the Members column can only go by loaded members, as with a permission, its header says **(loaded)**.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| Render Role Styles | On | Shows gradient and holographic role colours on the colour dot |
| Permission Sort Order | Importance | Importance (the dangerous ones like Administrator first), Discord default, or Alphabetical |
| Show Permission Icons | On | Small icons next to important permissions like Administrator, Ban and Kick |
| Show Member Count | On | The member count next to each role |
| Search Box | On | The search box at the top of each column |

## Known limits

- Permissions are server-wide role permissions. Channel overrides aren't included, so a role that has a permission here can still be blocked in a specific channel.
- Role counts and the "who has this permission" list only cover members Discord has loaded.
- The member search shows up to 100 matches per search, which is what Discord returns.

## Privacy

It only shows what your Discord client can already see. The only requests it makes are Discord's own member lookups: a role's member list when you select it, and the member search.

## Author

Made by 3xyy ([Discord](https://discord.com/users/596844241058267168)). GPL-3.0-or-later.
