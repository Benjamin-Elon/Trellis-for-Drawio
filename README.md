Trellis for Drawio extends Draw.io with a coordinated suite of plugins that turn diagrams into interactive, computational garden plans.

Several of the plugins depend on local database access, requiring the slightly modified version of Draw.io included in this repository . The only changes are a file system bridge for Database access, and new built-in plugins.

**Features:**

- Create yearly business plans.
- Draw beds, garden zones, and modules.
- Drag crops into place and generate schedules based on climate, GDD, frost windows, and plant traits.
- Plan multi-crop successions and turnovers.
- Manage tasks with Automated, linked Kanban boards.
- Build multi-person workflows using role cards and team modules.
- Automatically track and visualize when diagram elements were created or edited, using time-based coloring, filtering, and navigation to explore change history directly on the canvas.
- In addition to all the base features included ini Draw.io

**Who This Is For**

- Home gardeners
- Market gardeners
- School garden programs and teachers
- Urban agriculture projects
- Designers seeking visual + computational diagrams
- Anyone who dislikes juggling spreadsheets and calendar apps

**Why Draw.io?** 

Draw.io offers:

- A fast, responsive graphical canvas
- XML-structured shapes (ideal for embedding data)
- A plugin system with full graph access
- Zero required server dependencies (extensible for web, app and server)
- Compatibility with existing Draw.io diagrams

**To run this:**

1. npm install (in the root directory of this repo)
2. npm start (in the root directory of this repo runs the app. For debugging, use npm start --enable-logging.)

**To Build The Project:** 

In the root directory of this repo:
"npm run release-win"
"npm run release-win32"
"npm run release-win-arm64"
"npm run release-appx"
"npm run release-linux"
"npm run release-snap"


**Getting started:**

1. Run or build the project.
2. Go to plugin menu (under extras) and install the built in plugins.
3. Create modules --> team and garden modules
4. Most actions are in the right click context menu.
5. **Have Fun and contribute if you so desire!**

**High priority TODO Features:**
- Extend Dashboard plugin to include year planning
- Add users plugin and extend changeMap plugin
- Extend garden layout plugin to show scale
- Extend planner to include bed turnover mode
- Add Gantt plugin
- Extend scheduler with proper perrenial scheduling.
