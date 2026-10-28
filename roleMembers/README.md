# RoleMembers

Shows a server's roles, their permissions and their members in one three-column window.

## Features

- **Roles** column: the owner pinned at the top, then every role from highest to lowest, ending with @everyone. Each role shows its color (including gradient and holographic styles), its icon and a member count.
- **Permissions** column: the server-wide permissions of the selected role, owner or member, with Discord's own description for each. Administrator grants every permission, as in Discord.
- **Members** column: everyone with the selected role. Selecting a member shows their combined permissions (all roles plus @everyone).
- Reverse lookup: select a permission to list every role and member that has it, including the owner and administrators.
- A search box per column. The member search queries the whole server, not only the selected role.
- Resizable columns.

## Screenshots

![The three-column roles window](../assets/roleMembers/modal.png)

## Usage

1. Right-click a server icon, or click the server name above the channel list, and choose **Role Members**.
2. Select a role to see its permissions and members.
3. Select a member to see their combined permissions. Select them again to return.
4. Select a permission to see who has it. Select it again to return.
5. Use the profile button on a member to open their Discord profile.
6. Drag the dividers between columns to resize them.

## Settings

| Setting | Default | Description |
|---|---|---|
| Render Role Styles | On | Shows gradient and holographic role styles on the color dot. |
| Permission Sort Order | Importance | Importance (dangerous permissions such as Administrator first), Discord default, or Alphabetical. |
| Show Permission Icons | On | Shows icons next to important permissions such as Administrator, Ban and Kick. |
| Show Member Count | On | Shows a member count next to each role. |
| Search Box | On | Shows a search box at the top of each column. |

## Requirements

- Vencord built from source.

## Notes

### Member loading

Discord loads members of large servers on demand. When a role is selected, RoleMembers requests that role's members. Because these requests are rate limited, the plugin:

- waits briefly after a click, so browsing through roles does not send a request for each one;
- requests each role at most once per Discord session;
- never requests @everyone, which would fetch the entire server.

Role counts cover only loaded members, except @everyone, which shows the server total. When the Members column depends on loaded members only, as in a permission lookup, its header shows **(loaded)**.

### Limitations

- Permissions are server-wide role permissions. Channel overrides are not included.
- Role counts and permission lookups cover only members Discord has loaded.
- The member search returns up to 100 matches, the maximum Discord returns.
- The plugin shows only data the Discord client can already see. Its only requests are Discord's own member lookups.

## Author

3xyy ([Discord](https://discord.com/users/596844241058267168)). GPL-3.0-or-later.
