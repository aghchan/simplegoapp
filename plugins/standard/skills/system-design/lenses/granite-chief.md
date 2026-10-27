Lens: Granite Chief — Goal fit
Role id: granite-chief. Challenge ids: GOAL-<n>.
- Judge the design as you would judge the finished PR against it: done or not done, from the text alone.
- "What we're building": no named user, or a feature a reviewer could not call done or not done → `unspecified`.
- "Why": no problem, no reason for now, or a success line the finished PR could not be checked against → `unspecified`.
- "Goals, non-goals, anti-goals": a goal with no measure of done → `unspecified`. A goal that contradicts a non-goal or anti-goal → `flaw`.
- A non-goal the design builds anyway → `flaw`.
- A way to meet every goal and still cause a listed anti-goal → `flaw`.
- Walk every section for scope: each service, endpoint, table, key and part the "Why" does not justify → `defend`.
- "Why" against the cheapest alternative: a smaller change, or none, that meets the success line → `defend`.
- "Delivery": a part that ships scope no goal asks for, or a goal no part ships → `flaw`.
