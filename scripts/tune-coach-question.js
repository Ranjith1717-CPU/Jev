'use strict';

// Tries alternative wordings of one /coach question against the local
// anonymised sessions and reports catch rate vs false alarms for each.
//   node scripts/tune-coach-question.js [question=erosion]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { askJev } = require('../lib/jev');

const KEY = process.argv[2] || 'erosion';
const sessions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'private', 'coaching-sessions.json'), 'utf8'));
const pos = sessions.filter((s) => s.truth[KEY] === true);
const neg = sessions.filter((s) => s.truth[KEY] === false);

const VARIANTS = {
  erosion: {
    current: 'Is anyone in the room losing belief in the value of the coaching, or is their rapport with the coach cooling (questioning what it delivers, guarded, short answers, wanting to skip sessions)?',
    cost_and_doubt: 'Does anyone signal doubt about whether the coaching is worth it: asking to cut sessions, cadence or cost, questioning results, frustration with the coaching process, or cooler rapport with the coach?',
    notes_driven: "Do the coach's notes show anyone's sense of value from the coaching (ROI perception), their chemistry with the coach, or the coaching's affordability going down?",
    combined: "Is anyone's sense of value from the coaching, their chemistry with the coach, or the coaching's affordability going down (in the coach's notes or in what was said: questioning results, asking to cut sessions or cost, guarded or cooler with the coach, wanting to skip)?",
  },
  drift: {
    current: 'Is any individual in the room drifting (showing doubt, disengagement, or wanting out), even if the session as a whole sounds positive?',
    specific_person: 'Is a specific named person clearly disengaged, doubtful about the engagement, or signalling they want out? Ordinary business stress or a busy week does not count.',
  },
}[KEY];

(async () => {
  for (const [name, instructions] of Object.entries(VARIANTS)) {
    const run = async (list) => {
      const ps = [];
      for (let i = 0; i < list.length; i += 8) {
        ps.push(...(await Promise.all(list.slice(i, i + 8).map((s) =>
          askJev({ state: s.text, questions: { q: { type: 'noul', instructions } } }).then((r) => r.raw.answers.q.noul).catch(() => null)))));
      }
      return ps;
    };
    const pp = await run(pos), np = await run(neg);
    for (const th of [0.5, 0.35]) {
      const tp = pp.filter((p) => p !== null && p >= th).length, fp = np.filter((p) => p !== null && p >= th).length;
      console.log(`${name.padEnd(16)} @${th}: caught ${tp}/${pos.length}, false alarms ${fp}/${neg.length}`);
    }
  }
})();
