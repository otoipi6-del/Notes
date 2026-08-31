// ===== Notes App - Main JavaScript =====

dayjs.locale('ru');

// ===== Database =====
let db;
let useMemory = false;
let memStore = { tasks: [], categories: [], attachments: [], syncQueue: [] };
let nextId = { tasks: 1, categories: 1, attachments: 1, syncQueue: 1 };

const DEFAULT_CATEGORIES = [
  { name: 'Работа', order: 1 },
  { name: 'Личное', order: 2 },
  { name: 'Здоровье', order: 3 },
  { name: 'Другое', order: 4 }
];

async function initDB() {
  console.log('[Notes] Starting DB init...');

  // Always delete old DB to avoid schema mismatch
  try {
    await Dexie.delete('NotesAppDB');
    console.log('[Notes] Old DB deleted');
  } catch (e) {
    console.log('[Notes] No old DB to delete');
  }

  db = new Dexie('NotesAppDB');
  // Simple schema - only auto-increment id, filter in JS
  db.version(1).stores({
    tasks: '++id',
    categories: '++id',
    attachments: '++id',
    syncQueue: '++id'
  });

  try {
    await db.open();
    console.log('[Notes] IndexedDB opened OK');
  } catch (err) {
    console.warn('[Notes] IndexedDB failed, using memory:', err);
    useMemory = true;
    memStore.categories = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, ...c }));
    nextId.categories = 5;
    showToast('Работа без сохранения (режим инкогнито)');
    return;
  }

  try {
    const count = await db.categories.count();
    if (count === 0) {
      await db.categories.bulkAdd(DEFAULT_CATEGORIES);
      console.log('[Notes] Default categories added');
    }
  } catch (e) {
    console.warn('[Notes] Categories init error:', e);
  }
}

// DB wrapper functions
async function dbGetAll(table) {
  if (useMemory) return memStore[table].slice();
  return db[table].toArray();
}

async function dbGet(table, id) {
  if (useMemory) return memStore[table].find(x => x.id === id) || null;
  return db[table].get(id);
}

async function dbAdd(table, data) {
  console.log('[Notes] dbAdd', table, JSON.stringify(data).substring(0, 200));
  if (useMemory) {
    const id = nextId[table]++;
    memStore[table].push({ ...data, id: id });
    return id;
  }
  try {
    const id = await db[table].add(data);
    console.log('[Notes] DB add success, id=', id);
    return id;
  } catch (err) {
    console.error('[Notes] DB add FAILED:', err, 'data=', data);
    throw err;
  }
}

async function dbUpdate(table, id, data) {
  if (useMemory) {
    const idx = memStore[table].findIndex(x => x.id === id);
    if (idx >= 0) memStore[table][idx] = { ...memStore[table][idx], ...data };
    return;
  }
  return db[table].update(id, data);
}

async function dbDelete(table, id) {
  if (useMemory) {
    memStore[table] = memStore[table].filter(x => x.id !== id);
    return;
  }
  return db[table].delete(id);
}

async function dbBulkPut(table, items) {
  if (useMemory) {
    for (const item of items) {
      const idx = memStore[table].findIndex(x => x.id === item.id);
      if (idx >= 0) memStore[table][idx] = item;
      else memStore[table].push(item);
    }
    return;
  }
  return db[table].bulkPut(items);
}

async function dbClear(table) {
  if (useMemory) { memStore[table] = []; return; }
  return db[table].clear();
}

// ===== State =====
let currentView = 'list';
let currentDate = dayjs();
let selectedCalendarDate = null;
let editingTaskId = null;
let tempAttachments = [];
let categories = [];
let gasUrl = localStorage.getItem('gasUrl') || '';
let tgToken = localStorage.getItem('tgToken') || '';
let tgChatId = localStorage.getItem('tgChatId') || '';
let ghToken = localStorage.getItem('ghToken') || '';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initDB();
    initTheme();
    initEventListeners();
    await loadCategories();
    renderView();
    checkNotifications();
    setInterval(checkNotifications, 30000);
    setInterval(syncWithGAS, 60000);
    registerServiceWorker();
    console.log('[Notes] App initialized OK');
  } catch (err) {
    console.error('[Notes] Init error:', err);
    showToast('Ошибка запуска: ' + err.message);
  }
});

function initTheme() {
  const theme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

function initEventListeners() {
  $$('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentView = tab.dataset.view;
      renderView();
    });
  });

  $('#addTaskBtn').addEventListener('click', () => openTaskModal());
  $('#taskForm').addEventListener('submit', saveTask);

  $('#searchBtn').addEventListener('click', () => {
    $('#searchBar').classList.toggle('hidden');
    if (!$('#searchBar').classList.contains('hidden')) $('#searchInput').focus();
  });
  $('#closeSearch').addEventListener('click', () => {
    $('#searchBar').classList.add('hidden');
    $('#searchInput').value = '';
    renderView();
  });
  $('#searchInput').addEventListener('input', () => renderView());
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#categoryFilter').addEventListener('change', () => renderView());
  $('#priorityFilter').addEventListener('change', () => renderView());

  $('#prevMonth').addEventListener('click', () => { currentDate = currentDate.subtract(1, 'month'); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { currentDate = currentDate.add(1, 'month'); renderCalendar(); });
  $('#clearArchive').addEventListener('click', clearArchive);

  $$('.close-modal').forEach(btn => btn.addEventListener('click', closeAllModals));
  $$('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeAllModals(); });
  });

  $('#menuBtn').addEventListener('click', () => {
    $('#sideMenu').classList.add('open');
    $('#menuOverlay').classList.add('active');
  });
  $('#closeMenu').addEventListener('click', closeMenu);
  $('#menuOverlay').addEventListener('click', closeMenu);

  $('#menuCategories').addEventListener('click', () => { closeMenu(); openCategoriesModal(); });
  $('#menuSettings').addEventListener('click', () => { closeMenu(); openSettingsModal(); });
  $('#menuAbout').addEventListener('click', () => { closeMenu(); showToast('Заметки v1.0.0'); });

  $('#deleteTaskBtn').addEventListener('click', deleteTask);
  $('#archiveTaskBtn').addEventListener('click', archiveTaskFromModal);

  $('#addFileBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', handleFileSelect);
  $('#addLinkBtn').addEventListener('click', () => $('#linkModal').classList.add('active'));
  $('#saveLinkBtn').addEventListener('click', saveLink);

  $('#addCategoryBtn').addEventListener('click', addCategory);

  $('#syncBtn').addEventListener('click', syncWithGAS);
  $('#testGasBtn').addEventListener('click', testGAS);
  $('#testTgBtn').addEventListener('click', testTelegram);
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importData);
  $('#requestNotifBtn').addEventListener('click', requestNotificationPermission);

  $('#gasUrl').addEventListener('change', (e) => { gasUrl = e.target.value; localStorage.setItem('gasUrl', gasUrl); });
  $('#tgToken').addEventListener('change', (e) => { tgToken = e.target.value; localStorage.setItem('tgToken', tgToken); });
  $('#tgChatId').addEventListener('change', (e) => { tgChatId = e.target.value; localStorage.setItem('tgChatId', tgChatId); });
  $('#ghToken').addEventListener('change', (e) => { ghToken = e.target.value; localStorage.setItem('ghToken', ghToken); });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });
}

function closeMenu() {
  $('#sideMenu').classList.remove('open');
  $('#menuOverlay').classList.remove('active');
}

function closeAllModals() {
  $$('.modal').forEach(m => m.classList.remove('active'));
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

async function loadCategories() {
  categories = await dbGetAll('categories');
  categories.sort((a, b) => (a.order || 0) - (b.order || 0));
  updateCategorySelects();
}

function updateCategorySelects() {
  const options = categories.map(c => '<option value="' + c.name + '">' + c.name + '</option>').join('');
  $('#taskCategory').innerHTML = options;
  $('#categoryFilter').innerHTML = '<option value="">Все категории</option>' + options;
}

async function addCategory() {
  const name = $('#newCategoryName').value.trim();
  if (!name) return;
  const exists = categories.some(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) { showToast('Категория уже существует'); return; }
  await dbAdd('categories', { name: name, order: categories.length + 1 });
  await loadCategories();
  $('#newCategoryName').value = '';
  renderCategoriesList();
  showToast('Категория добавлена');
}

async function deleteCategory(id) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  const allTasks = await dbGetAll('tasks');
  const tasksWithCat = allTasks.filter(t => t.category === cat.name);
  if (tasksWithCat.length > 0) { showToast('Нельзя удалить: есть задачи'); return; }
  await dbDelete('categories', id);
  await loadCategories();
  renderCategoriesList();
  showToast('Категория удалена');
}

function renderCategoriesList() {
  $('#categoriesList').innerHTML = categories.map(c =>
    '<div class="category-item"><span>' + c.name + '</span>' +
    '<button class="icon-btn" onclick="deleteCategory(' + c.id + ')" title="Удалить">🗑</button></div>'
  ).join('');
}

function openCategoriesModal() {
  renderCategoriesList();
  $('#categoriesModal').classList.add('active');
}

function openTaskModal(task) {
  editingTaskId = task ? task.id : null;
  $('#modalTitle').textContent = task ? 'Редактировать' : 'Новая задача';
  $('#taskId').value = task ? task.id : '';
  $('#taskTitle').value = task ? task.title : '';
  $('#taskDesc').value = task ? (task.description || '') : '';
  $('#taskCategory').value = task ? (task.category || categories[0].name) : categories[0].name;
  $('#taskPriority').value = task ? (task.priority || 'medium') : 'medium';
  $('#taskDate').value = task && task.date ? task.date : dayjs().format('YYYY-MM-DD');
  $('#taskTime').value = task && task.time ? task.time : '';
  $('#taskRecurrence').value = task ? (task.recurrence || 'none') : 'none';
  $('#taskNotify').value = task ? (task.notifyBefore || 0) : 0;
  $('#taskSound').value = task ? (task.sound || 'default') : 'default';
  $('#taskGCal').checked = task ? (task.gcal || false) : false;
  $('#taskTelegram').checked = task ? (task.telegram || false) : false;

  tempAttachments = task ? (task.attachments || []) : [];
  renderTempAttachments();

  $('#deleteTaskBtn').style.display = task ? 'inline-block' : 'none';
  $('#archiveTaskBtn').style.display = task ? 'inline-block' : 'none';
  $('#taskModal').classList.add('active');
}

async function saveTask(e) {
  e.preventDefault();
  const taskData = {
    title: $('#taskTitle').value.trim(),
    description: $('#taskDesc').value.trim(),
    category: $('#taskCategory').value,
    priority: $('#taskPriority').value,
    date: $('#taskDate').value,
    time: $('#taskTime').value || null,
    recurrence: $('#taskRecurrence').value,
    notifyBefore: parseInt($('#taskNotify').value),
    sound: $('#taskSound').value,
    gcal: $('#taskGCal').checked,
    telegram: $('#taskTelegram').checked,
    attachments: tempAttachments,
    updatedAt: Date.now()
  };

  if (!taskData.title) { showToast('Введите заголовок'); return; }

  console.log('[Notes] Saving task:', taskData);

  try {
    let taskId;
    if (editingTaskId) {
      await dbUpdate('tasks', editingTaskId, taskData);
      const allAtts = await dbGetAll('attachments');
      const atts = allAtts.filter(a => a.taskId === editingTaskId);
      for (const a of atts) await dbDelete('attachments', a.id);
      for (const att of tempAttachments) await dbAdd('attachments', { taskId: editingTaskId, type: att.type, name: att.name, data: att.data || null, url: att.url || null, mimeType: att.mimeType || null });
      taskId = editingTaskId;
      showToast('Задача обновлена');
    } else {
      taskData.completed = false;
      taskData.archived = false;
      taskData.createdAt = Date.now();
      console.log('[Notes] About to dbAdd tasks with:', taskData);
      taskId = await dbAdd('tasks', taskData);
      for (const att of tempAttachments) {
        await dbAdd('attachments', { taskId: taskId, type: att.type, name: att.name, data: att.data || null, url: att.url || null, mimeType: att.mimeType || null });
      }
      showToast('Задача создана');
    }

    console.log('[Notes] Task saved, id=' + taskId);
    queueSync('upsert', 'tasks', { id: taskId, ...taskData });

    if (taskData.gcal && taskData.date) addToGoogleCalendar(taskData);
    if (taskData.telegram) sendTelegramNotification(taskData);

    closeAllModals();
    renderView();
  } catch (err) {
    console.error('[Notes] Save error:', err);
    showToast('Ошибка сохранения: ' + err.message);
  }
}

async function toggleTaskComplete(id) {
  const task = await dbGet('tasks', id);
  if (!task) return;
  const newCompleted = !task.completed;
  await dbUpdate('tasks', id, { completed: newCompleted, updatedAt: Date.now() });
  if (newCompleted && task.recurrence !== 'none') await createRecurringTask(task);
  queueSync('upsert', 'tasks', { id: id, completed: newCompleted, updatedAt: Date.now() });
  renderView();
  showToast(newCompleted ? 'Выполнено' : 'Активно');
}

async function createRecurringTask(task) {
  const nextDate = task.recurrence === 'daily' ? dayjs(task.date).add(1, 'day') :
                   task.recurrence === 'weekly' ? dayjs(task.date).add(1, 'week') :
                   task.recurrence === 'yearly' ? dayjs(task.date).add(1, 'year') :
                   dayjs(task.date);
  const newTask = {
    title: task.title,
    description: task.description,
    category: task.category,
    priority: task.priority,
    date: nextDate.format('YYYY-MM-DD'),
    time: task.time,
    recurrence: task.recurrence,
    notifyBefore: task.notifyBefore,
    sound: task.sound,
    gcal: task.gcal,
    telegram: task.telegram,
    attachments: task.attachments,
    completed: false,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await dbAdd('tasks', newTask);
  showToast('Создана повторяющаяся задача');
}

async function deleteTask() {
  if (!editingTaskId) return;
  if (!confirm('Удалить задачу безвозвратно?')) return;
  await dbDelete('tasks', editingTaskId);
  const allAtts = await dbGetAll('attachments');
  const atts = allAtts.filter(a => a.taskId === editingTaskId);
  for (const a of atts) await dbDelete('attachments', a.id);
  queueSync('delete', 'tasks', { id: editingTaskId });
  closeAllModals();
  renderView();
  showToast('Задача удалена');
}

async function archiveTaskFromModal() {
  if (!editingTaskId) return;
  await dbUpdate('tasks', editingTaskId, { archived: true, completed: true, updatedAt: Date.now() });
  queueSync('upsert', 'tasks', { id: editingTaskId, archived: true, completed: true });
  closeAllModals();
  renderView();
  showToast('Задача в архиве');
}

async function restoreFromArchive(id) {
  await dbUpdate('tasks', id, { archived: false, completed: false, updatedAt: Date.now() });
  queueSync('upsert', 'tasks', { id: id, archived: false, completed: false });
  renderView();
  showToast('Задача восстановлена');
}

async function deleteFromArchive(id) {
  if (!confirm('Удалить из архива?')) return;
  await dbDelete('tasks', id);
  const allAtts = await dbGetAll('attachments');
  const atts = allAtts.filter(a => a.taskId === id);
  for (const a of atts) await dbDelete('attachments', a.id);
  queueSync('delete', 'tasks', { id: id });
  renderView();
  showToast('Удалено из архива');
}

async function clearArchive() {
  const allTasks = await dbGetAll('tasks');
  const archived = allTasks.filter(t => t.archived);
  if (archived.length === 0) { showToast('Архив пуст'); return; }
  if (!confirm('Удалить ' + archived.length + ' задач?')) return;
  for (const t of archived) {
    await dbDelete('tasks', t.id);
    const allAtts = await dbGetAll('attachments');
    const atts = allAtts.filter(a => a.taskId === t.id);
    for (const a of atts) await dbDelete('attachments', a.id);
    queueSync('delete', 'tasks', { id: t.id });
  }
  renderView();
  showToast('Архив очищен');
}

async function snoozeTask(id, minutes) {
  minutes = minutes || 15;
  const task = await dbGet('tasks', id);
  if (!task) return;
  const newTime = dayjs().add(minutes, 'minute');
  await dbUpdate('tasks', id, {
    date: newTime.format('YYYY-MM-DD'),
    time: newTime.format('HH:mm'),
    notifyBefore: 0,
    updatedAt: Date.now()
  });
  queueSync('upsert', 'tasks', { id: id, date: newTime.format('YYYY-MM-DD'), time: newTime.format('HH:mm') });
  renderView();
  showToast('Отложено на ' + minutes + ' минут');
}

function renderTempAttachments() {
  $('#attachmentsList').innerHTML = tempAttachments.map((att, i) =>
    '<div class="attachment-item"><span>' + (att.type === 'link' ? '🔗' : '📎') + ' ' + att.name + '</span>' +
    '<button type="button" class="icon-btn" onclick="removeAttachment(' + i + ')">✕</button></div>'
  ).join('');
}

function removeAttachment(index) {
  tempAttachments.splice(index, 1);
  renderTempAttachments();
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      tempAttachments.push({ type: 'file', name: file.name, data: ev.target.result, mimeType: file.type });
      renderTempAttachments();
    };
    reader.readAsDataURL(file);
  }
  e.target.value = '';
}

function saveLink() {
  const name = $('#linkName').value.trim();
  const url = $('#linkUrl').value.trim();
  if (!url) { showToast('Введите URL'); return; }
  tempAttachments.push({ type: 'link', name: name || url, url: url });
  $('#linkName').value = '';
  $('#linkUrl').value = '';
  $('#linkModal').classList.remove('active');
  renderTempAttachments();
}

async function renderView() {
  if (currentView === 'list') await renderList();
  else if (currentView === 'calendar') renderCalendar();
  else if (currentView === 'archive') await renderArchive();
}

async function renderList() {
  const search = $('#searchInput').value.toLowerCase();
  const catFilter = $('#categoryFilter').value;
  const priFilter = $('#priorityFilter').value;

  let tasks = await dbGetAll('tasks');
  tasks = tasks.filter(t => !t.archived);
  console.log('[Notes] renderList total active:', tasks.length);

  if (search) tasks = tasks.filter(t => t.title.toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search));
  if (catFilter) tasks = tasks.filter(t => t.category === catFilter);
  if (priFilter) tasks = tasks.filter(t => t.priority === priFilter);

  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const da = dayjs(a.date + ' ' + (a.time || '00:00'));
    const db_ = dayjs(b.date + ' ' + (b.time || '00:00'));
    return da.diff(db_);
  });

  const list = $('#taskList');
  if (tasks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div class="empty-state-text">Нет задач. Нажмите + чтобы создать!</div></div>';
    return;
  }
  list.innerHTML = tasks.map(t => renderTaskCard(t)).join('');
}

function renderTaskCard(t) {
  const dateStr = t.date ? dayjs(t.date).format('DD.MM.YY') : '';
  const timeStr = t.time || '';
  const hasAtt = t.attachments && t.attachments.length > 0;
  const hasNotify = t.notifyBefore > 0;
  const isRecurring = t.recurrence && t.recurrence !== 'none';

  return '<div class="task-card priority-' + (t.priority || 'medium') + (t.completed ? ' completed' : '') + '" data-id="' + t.id + '">' +
    '<div class="task-header">' +
      '<div class="task-title">' + escapeHtml(t.title) + '</div>' +
      '<div class="task-checkbox ' + (t.completed ? 'checked' : '') + '" onclick="event.stopPropagation(); toggleTaskComplete(' + t.id + ')">' + (t.completed ? '✓' : '') + '</div>' +
    '</div>' +
    (t.description ? '<div style="font-size:0.85rem;color:var(--text-secondary);margin-top:4px;">' + escapeHtml(t.description) + '</div>' : '') +
    '<div class="task-meta">' +
      (t.category ? '<span class="task-tag">' + escapeHtml(t.category) + '</span>' : '') +
      (dateStr ? '<span>📅 ' + dateStr + (timeStr ? ' ' + timeStr : '') + '</span>' : '') +
      (isRecurring ? '<span class="task-tag recurring">🔄</span>' : '') +
      (hasAtt ? '<span class="task-tag attachment">📎</span>' : '') +
      (hasNotify ? '<span class="task-tag notify">🔔 ' + t.notifyBefore + 'мин</span>' : '') +
    '</div>' +
    '<div class="task-actions">' +
      '<button onclick="event.stopPropagation(); openTaskModalById(' + t.id + ')">✏️ Изменить</button>' +
      '<button onclick="event.stopPropagation(); snoozeTask(' + t.id + ', 15)">⏰ +15мин</button>' +
    '</div>' +
  '</div>';
}

async function openTaskModalById(id) {
  const task = await dbGet('tasks', id);
  if (task) openTaskModal(task);
}

async function renderArchive() {
  let tasks = await dbGetAll('tasks');
  tasks = tasks.filter(t => t.archived).reverse();
  const list = $('#archiveList');
  if (tasks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🗄</div><div class="empty-state-text">Архив пуст</div></div>';
    return;
  }
  list.innerHTML = tasks.map(t =>
    '<div class="task-card priority-' + (t.priority || 'medium') + ' completed">' +
      '<div class="task-header"><div class="task-title">' + escapeHtml(t.title) + '</div></div>' +
      '<div class="task-meta">' +
        (t.category ? '<span class="task-tag">' + escapeHtml(t.category) + '</span>' : '') +
        '<span>✅ ' + (t.date ? dayjs(t.date).format('DD.MM.YY') : '') + '</span>' +
      '</div>' +
      '<div class="task-actions">' +
        '<button onclick="restoreFromArchive(' + t.id + ')">↩️ Восстановить</button>' +
        '<button onclick="deleteFromArchive(' + t.id + ')">🗑 Удалить</button>' +
      '</div>' +
    '</div>'
  ).join('');
}

function renderCalendar() {
  $('#calendarMonth').textContent = currentDate.format('MMMM YYYY');
  const startOfMonth = currentDate.startOf('month');
  const endOfMonth = currentDate.endOf('month');
  const startDay = startOfMonth.day() === 0 ? 6 : startOfMonth.day() - 1;
  const daysInMonth = endOfMonth.date();

  let html = '';
  for (let i = 0; i < startDay; i++) {
    const prevDay = startOfMonth.subtract(startDay - i, 'day');
    html += '<div class="cal-day other-month" data-date="' + prevDay.format('YYYY-MM-DD') + '">' + prevDay.date() + '</div>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = currentDate.date(d).format('YYYY-MM-DD');
    const isToday = date === dayjs().format('YYYY-MM-DD');
    const isSelected = selectedCalendarDate === date;
    html += '<div class="cal-day ' + (isToday ? 'today ' : '') + (isSelected ? 'selected' : '') + '" data-date="' + date + '" onclick="selectCalendarDate(\'' + date + '\')">' + d + '<div class="cal-dots" id="dots-' + date + '"></div></div>';
  }
  const totalCells = startDay + daysInMonth;
  const remaining = 42 - totalCells;
  for (let i = 1; i <= remaining; i++) {
    const nextDay = endOfMonth.add(i, 'day');
    html += '<div class="cal-day other-month" data-date="' + nextDay.format('YYYY-MM-DD') + '">' + nextDay.date() + '</div>';
  }
  $('#calendarDays').innerHTML = html;
  renderCalendarDots();
  if (selectedCalendarDate) renderCalendarTasks(selectedCalendarDate);
}

async function renderCalendarDots() {
  const tasks = await dbGetAll('tasks');
  const activeTasks = tasks.filter(t => !t.archived);
  const dotsByDate = {};
  activeTasks.forEach(t => {
    if (!t.date) return;
    if (!dotsByDate[t.date]) dotsByDate[t.date] = new Set();
    dotsByDate[t.date].add(t.priority || 'medium');
  });
  Object.entries(dotsByDate).forEach(([date, priorities]) => {
    const el = document.getElementById('dots-' + date);
    if (el) {
      el.innerHTML = Array.from(priorities).map(p => '<div class="cal-dot ' + p + '"></div>').join('');
    }
  });
}

async function selectCalendarDate(date) {
  selectedCalendarDate = date;
  $$('.cal-day').forEach(d => d.classList.remove('selected'));
  const dayEl = $('.cal-day[data-date="' + date + '"]');
  if (dayEl) dayEl.classList.add('selected');
  renderCalendarTasks(date);
}

async function renderCalendarTasks(date) {
  const tasks = await dbGetAll('tasks');
  const dayTasks = tasks.filter(t => !t.archived && t.date === date);
  const container = $('#calendarTasks');
  if (dayTasks.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Нет задач на ' + dayjs(date).format('DD.MM.YY') + '</div></div>';
    return;
  }
  container.innerHTML = '<h3 style="margin-bottom:10px;font-size:1rem;">📅 ' + dayjs(date).format('DD MMMM') + '</h3>' + dayTasks.map(t => renderTaskCard(t)).join('');
}

async function checkNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const now = dayjs();
  const tasks = await dbGetAll('tasks');
  const activeTasks = tasks.filter(t => !t.archived && !t.completed);
  for (const task of activeTasks) {
    if (!task.date) continue;
    const taskDateTime = dayjs(task.date + ' ' + (task.time || '00:00'));
    const notifyTime = taskDateTime.subtract(task.notifyBefore || 0, 'minute');
    const diff = notifyTime.diff(now, 'minute');
    if (diff >= 0 && diff < 1) {
      const notifKey = 'notif_' + task.id + '_' + taskDateTime.format('YYYY-MM-DD-HH-mm');
      if (!localStorage.getItem(notifKey)) {
        showNotification(task);
        localStorage.setItem(notifKey, '1');
      }
    }
  }
}

function showNotification(task) {
  playSound(task.sound || 'default');
  const notification = new Notification('🔔 Заметки', {
    body: task.title,
    icon: 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'%3E%3Crect width=\'100\' height=\'100\' rx=\'20\' fill=\'%234f46e5\'/%3E%3Ctext x=\'50\' y=\'68\' text-anchor=\'middle\' font-size=\'55\' fill=\'white\'%3E📝%3C/text%3E%3C/svg%3E',
    requireInteraction: true
  });
  notification.onclick = () => { window.focus(); openTaskModalById(task.id); };
}

function playSound(soundType) {
  const audio = $('#soundDefault');
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function requestNotificationPermission() {
  if (!('Notification' in window)) { showToast('Уведомления не поддерживаются'); return; }
  Notification.requestPermission().then(perm => {
    showToast(perm === 'granted' ? 'Уведомления включены' : 'Уведомления отклонены');
  });
}

async function sendTelegramNotification(task) {
  if (!tgToken || !tgChatId) return;
  if (window.location.protocol === 'file:') return;
  const text = '🔔 *Напоминание*\\\\n\\\\n*' + task.title + '*' + (task.description ? '\\\\n' + task.description : '') + '\\\\n📅 ' + task.date + (task.time ? ' ' + task.time : '');
  try {
    await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text: text, parse_mode: 'MarkdownV2' })
    });
  } catch (e) { console.error('TG error:', e); }
}

async function testTelegram() {
  if (!tgToken || !tgChatId) { showToast('Заполните Token и Chat ID'); return; }
  if (window.location.protocol === 'file:') {
    showToast('⚠️ Запустите через http://localhost');
    return;
  }
  showToast('📨 Отправка теста...');
  try {
    const res = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text: '📝 Заметки — Тест! Бот работает ✅' })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      showToast('✅ Сообщение отправлено!');
    } else {
      showToast('❌ Telegram: ' + (data.description || 'Неизвестная ошибка'));
    }
  } catch (e) {
    showToast('❌ Ошибка сети: ' + e.message);
  }
}

function addToGoogleCalendar(task) {
  const base = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
  const text = encodeURIComponent(task.title);
  const details = encodeURIComponent(task.description || '');
  const dates = task.date ? task.date.replace(/-/g, '') : '';
  window.open(base + '&text=' + text + '&details=' + details + '&dates=' + dates + '/' + dates, '_blank');
}

async function queueSync(action, table, data) {
  await dbAdd('syncQueue', { action: action, table: table, data: data, timestamp: Date.now() });
}

async function syncWithGAS() {
  if (!gasUrl) { showToast('Введите URL GAS в настройках'); return; }
  if (!navigator.onLine) { showToast('Нет интернет-соединения'); return; }
  if (window.location.protocol === 'file:') {
    showToast('⚠️ Запустите через http://localhost (см. инструкцию)');
    return;
  }

  const queue = await dbGetAll('syncQueue');
  queue.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  showToast('🔄 Синхронизация...');

  if (queue.length === 0) {
    try {
      const res = await fetch(gasUrl + '?action=getAll');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.tasks) {
        for (const t of data.tasks) {
          const existing = await dbGet('tasks', t.id);
          if (!existing || (existing.updatedAt || 0) < (t.updatedAt || 0)) await dbBulkPut('tasks', [t]);
        }
      }
      renderView();
      showToast('✅ Данные загружены с GAS');
    } catch (e) {
      console.error('Sync pull error:', e);
      showToast('❌ Ошибка GAS: ' + e.message);
    }
    return;
  }

  try {
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync', data: queue })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await dbClear('syncQueue');
    showToast('✅ Синхронизация завершена');
  } catch (e) {
    console.error('Sync push error:', e);
    showToast('❌ Ошибка GAS: ' + e.message);
  }
}

async function testGAS() {
  if (!gasUrl) { showToast('Введите URL GAS'); return; }
  if (window.location.protocol === 'file:') {
    showToast('⚠️ Запустите через http://localhost');
    return;
  }
  showToast('🔗 Проверка GAS...');
  try {
    const res = await fetch(gasUrl + '?action=getAll');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const taskCount = data.tasks ? data.tasks.length : 0;
    showToast('✅ GAS работает! Задач: ' + taskCount);
  } catch (e) {
    showToast('❌ GAS недоступен: ' + e.message);
  }
}

async function exportData() {
  const data = {
    tasks: await dbGetAll('tasks'),
    categories: await dbGetAll('categories'),
    attachments: await dbGetAll('attachments'),
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'notes_backup_' + dayjs().format('YYYY-MM-DD') + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Данные экспортированы');
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data.tasks) await dbBulkPut('tasks', data.tasks);
      if (data.categories) await dbBulkPut('categories', data.categories);
      if (data.attachments) await dbBulkPut('attachments', data.attachments);
      await loadCategories();
      renderView();
      showToast('Данные импортированы');
    } catch (err) { showToast('Ошибка импорта'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function openSettingsModal() {
  $('#gasUrl').value = gasUrl;
  $('#tgToken').value = tgToken;
  $('#tgChatId').value = tgChatId;
  $('#ghToken').value = ghToken;
  $('#settingsModal').classList.add('active');
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

window.addEventListener('online', () => { $('#syncStatus').textContent = 'Онлайн'; syncWithGAS(); });
window.addEventListener('offline', () => { $('#syncStatus').textContent = 'Офлайн'; });
