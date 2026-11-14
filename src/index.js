export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve static frontend (public/index.html) for non-API requests
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      // GET /api/state?week=YYYY-MM-DD
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const week = url.searchParams.get('week') || '';
        const [cRes, pRes, wRes, mRes, wcRes] = await env.DB.batch([
          env.DB.prepare('SELECT id, name, active, color, sort FROM classes'),
          env.DB.prepare('SELECT id, name, classId, grade, leader, active, reachedWeek, reachedAt FROM people'),
          env.DB.prepare('SELECT week, submitted, at, roster, present FROM weeks'),
          env.DB.prepare('SELECT personId FROM marks WHERE week = ?').bind(week),
          env.DB.prepare('SELECT classId, at, roster, present FROM week_classes WHERE week = ?').bind(week)
        ]);

        const classes = cRes.results.map(c => ({ ...c, active: !!c.active }));
        const people = pRes.results.map(p => ({ ...p, leader: !!p.leader, active: !!p.active }));
        const weeks = Object.fromEntries(
          wRes.results.map(w => [
            w.week,
            {
              submitted: !!w.submitted,
              at: w.at,
              roster: JSON.parse(w.roster || '{}'),
              present: JSON.parse(w.present || '[]')
            }
          ])
        );
        const marks = Object.fromEntries(mRes.results.map(m => [m.personId, 1]));
        const cdocs = Object.fromEntries(
          wcRes.results.map(d => [
            d.classId,
            {
              at: d.at,
              roster: JSON.parse(d.roster || '[]'),
              present: JSON.parse(d.present || '[]')
            }
          ])
        );

        return Response.json({ classes, people, weeks, marks, cdocs });
      }

      // POST /api/action
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await request.json();
        const { action } = body;

        switch (action) {
          case 'toggleMark':
            if (body.present) {
              await env.DB.prepare('INSERT OR REPLACE INTO marks (week, personId, t) VALUES (?, ?, ?)')
                .bind(body.week, body.personId, Date.now())
                .run();
            } else {
              await env.DB.prepare('DELETE FROM marks WHERE week = ? AND personId = ?')
                .bind(body.week, body.personId)
                .run();
            }
            break;

          case 'submitClass':
            await env.DB.prepare(
              'INSERT OR REPLACE INTO week_classes (week, classId, at, roster, present) VALUES (?, ?, ?, ?, ?)'
            )
              .bind(body.week, body.classId, body.at, JSON.stringify(body.roster), JSON.stringify(body.present))
              .run();
            break;

          case 'reopenClass':
            await env.DB.prepare('DELETE FROM week_classes WHERE week = ? AND classId = ?')
              .bind(body.week, body.classId)
              .run();
            break;

          case 'submitWeek':
            await env.DB.prepare(
              'INSERT OR REPLACE INTO weeks (week, submitted, at, roster, present) VALUES (?, 1, ?, ?, ?)'
            )
              .bind(body.week, body.at, JSON.stringify(body.roster), JSON.stringify(body.present))
              .run();
            break;

          case 'reopenWeek':
            await env.DB.prepare('UPDATE weeks SET submitted = 0 WHERE week = ?')
              .bind(body.week)
              .run();
            break;

          case 'addClass':
            await env.DB.prepare('INSERT INTO classes (id, name, active, color, sort) VALUES (?, ?, 1, ?, ?)')
              .bind(body.id, body.name, body.color, body.sort || 0)
              .run();
            break;

          case 'updateClass': {
            const allowed = ['name', 'color'];
            if (!allowed.includes(body.field)) return new Response('Invalid field', { status: 400 });
            await env.DB.prepare(`UPDATE classes SET ${body.field} = ? WHERE id = ?`)
              .bind(body.value, body.id)
              .run();
            break;
          }

          case 'reorderClasses':
            if (!Array.isArray(body.order)) return new Response('Invalid order', { status: 400 });
            await env.DB.batch(
              body.order.map((id, i) => env.DB.prepare('UPDATE classes SET sort = ? WHERE id = ?').bind(i, id))
            );
            break;

          case 'removeClass':
            await env.DB.prepare('UPDATE classes SET active = 0 WHERE id = ?')
              .bind(body.id)
              .run();
            break;

          case 'addPerson':
            await env.DB.prepare(
              'INSERT INTO people (id, name, classId, grade, leader, active) VALUES (?, ?, ?, ?, ?, 1)'
            )
              .bind(body.id, body.name, body.classId, body.grade || '', body.leader ? 1 : 0)
              .run();
            break;

          case 'updatePerson': {
            const allowed = ['name', 'classId', 'grade', 'leader'];
            if (!allowed.includes(body.field)) return new Response('Invalid field', { status: 400 });
            const val = body.field === 'leader' ? (body.value ? 1 : 0) : body.value;
            await env.DB.prepare(`UPDATE people SET ${body.field} = ? WHERE id = ?`)
              .bind(val, body.id)
              .run();
            break;
          }

          case 'removePerson':
            await env.DB.prepare('UPDATE people SET active = 0 WHERE id = ?')
              .bind(body.id)
              .run();
            break;

          case 'reachPerson':
            await env.DB.prepare('UPDATE people SET reachedWeek = ?, reachedAt = ? WHERE id = ?')
              .bind(body.reachedWeek || '', body.reachedAt || 0, body.id)
              .run();
            break;

          default:
            return new Response('Unknown action', { status: 400 });
        }

        return Response.json({ ok: true });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }
};
