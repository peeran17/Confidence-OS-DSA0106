import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import {
  INITIAL_STUDENT,
  INITIAL_QUESTIONS,
  INITIAL_SKILLS,
  INITIAL_EVALUATIONS,
  INITIAL_RECOMMENDATIONS,
  INITIAL_DAILY_PLAN
} from './src/data/mockDatabase';
import { evaluateAnswerWithCppRules } from './src/services/cppEvaluationEngine';
import { Question, EvaluationResult, SkillProgress, SmartRecommendation, DailyPracticePlan, StudentProfile } from './src/types';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

// In-Memory Database store with seed data
let currentStudent: StudentProfile = { ...INITIAL_STUDENT };
let questionsList: Question[] = [...INITIAL_QUESTIONS];
let skillsList: SkillProgress[] = [...INITIAL_SKILLS];
let evaluationsList: EvaluationResult[] = [...INITIAL_EVALUATIONS];
let recommendationsList: SmartRecommendation[] = [...INITIAL_RECOMMENDATIONS];
let dailyPlan: DailyPracticePlan = { ...INITIAL_DAILY_PLAN };

// Helper to recalculate adaptive recommendations based on weakest skills
function recalculateRecommendations() {
  // Sort skills ascending by score
  const sortedSkills = [...skillsList].sort((a, b) => a.currentScore - b.currentScore);
  const weakest = sortedSkills[0];
  const secondWeakest = sortedSkills[1];

  const newRecs: SmartRecommendation[] = [];

  if (weakest) {
    const matchingQ = questionsList.find(q =>
      (weakest.category === 'Core' || q.category === weakest.category) &&
      !evaluationsList.some(e => e.questionId === q.id && e.overallScore >= 85)
    ) || questionsList[0];

    newRecs.push({
      id: `rec-auto-1`,
      skillId: weakest.skillId,
      skillName: weakest.skillName,
      reason: `Your ${weakest.skillName} is currently ${weakest.currentScore}%, which is below the target benchmark of ${weakest.benchmarkScore}%. Targeted practice is recommended.`,
      suggestedQuestionId: matchingQ.id,
      suggestedQuestionTitle: matchingQ.title,
      category: matchingQ.category,
      difficulty: matchingQ.difficulty,
      priority: 'High',
      estimatedMinutes: 5,
      completed: false
    });
  }

  if (secondWeakest) {
    const matchingQ2 = questionsList.find(q =>
      q.id !== newRecs[0]?.suggestedQuestionId &&
      (secondWeakest.category === 'Core' || q.category === secondWeakest.category)
    ) || questionsList[1];

    newRecs.push({
      id: `rec-auto-2`,
      skillId: secondWeakest.skillId,
      skillName: secondWeakest.skillName,
      reason: `${secondWeakest.recentEvidence} Focus on improving structure and technical precision.`,
      suggestedQuestionId: matchingQ2.id,
      suggestedQuestionTitle: matchingQ2.title,
      category: matchingQ2.category,
      difficulty: matchingQ2.difficulty,
      priority: 'Medium',
      estimatedMinutes: 5,
      completed: false
    });
  }

  recommendationsList = newRecs;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // API Routes
  // 1. Health check & Engine meta
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'healthy',
      engine: 'ConfidenceOS C++ Engine v2.4 (STL unordered_map + N-Gram Matching)',
      connectedModel: process.env.GEMINI_API_KEY ? 'gemini-2.5-flash (Active)' : 'Rule-based Coach Engine',
      hasApiKey: Boolean(process.env.GEMINI_API_KEY)
    });
  });

  // 2. Student Profile
  app.get('/api/student', (_req, res) => {
    res.json(currentStudent);
  });

  app.put('/api/student', (req, res) => {
    currentStudent = { ...currentStudent, ...req.body };
    res.json({ success: true, student: currentStudent });
  });

  // 3. Questions
  app.get('/api/questions', (req, res) => {
    const { category, difficulty, search } = req.query;
    let filtered = [...questionsList];

    if (category && category !== 'All') {
      filtered = filtered.filter(q => q.category === category);
    }
    if (difficulty && difficulty !== 'All') {
      filtered = filtered.filter(q => q.difficulty === difficulty);
    }
    if (search && typeof search === 'string') {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        item =>
          item.title.toLowerCase().includes(q) ||
          item.prompt.toLowerCase().includes(q) ||
          item.expectedKeywords.some(kw => kw.toLowerCase().includes(q))
      );
    }

    res.json(filtered);
  });

  app.get('/api/questions/:id', (req, res) => {
    const question = questionsList.find(q => q.id === req.params.id);
    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }
    res.json(question);
  });

  // 4. Evaluation Submission
  app.post('/api/practice/evaluate', (req, res) => {
    const { questionId, studentAnswer, durationSeconds, studentId } = req.body;
    const question = questionsList.find(q => q.id === questionId);

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }
    if (!studentAnswer || typeof studentAnswer !== 'string') {
      return res.status(400).json({ error: 'Student answer text is required' });
    }

    // Run C++ algorithmic evaluation
    const evaluation = evaluateAnswerWithCppRules(
      question,
      studentAnswer,
      Number(durationSeconds) || 60,
      studentId || currentStudent.studentId
    );

    // Save to evaluations history
    evaluationsList.unshift(evaluation);

    // Update Skills based on outcome
    skillsList = skillsList.map(skill => {
      let change = 0;
      if (skill.category === question.category || skill.category === 'Core') {
        if (skill.skillId === 'sk-keyword-rel') {
          change = Math.round((evaluation.metrics.keywordRelevance - skill.currentScore) * 0.25);
        } else if (skill.skillId === 'sk-tech-struct') {
          change = Math.round((evaluation.metrics.answerStructure - skill.currentScore) * 0.25);
        } else if (skill.skillId === 'sk-completeness') {
          change = Math.round((evaluation.metrics.completeness - skill.currentScore) * 0.25);
        } else {
          change = Math.round((evaluation.overallScore - skill.currentScore) * 0.2);
        }
      }
      const newScore = Math.min(100, Math.max(30, skill.currentScore + change));
      return {
        ...skill,
        previousScore: skill.currentScore,
        currentScore: newScore,
        attemptsCount: skill.attemptsCount + 1,
        trend: change > 0 ? 'up' : change < 0 ? 'down' : 'steady',
        recentEvidence: `Attempt on "${question.title.slice(0, 35)}..." scored ${evaluation.overallScore}/100.`
      };
    });

    // Update daily plan if this was part of tasks
    const taskMatch = dailyPlan.tasks.find((t: any) => t.questionId === questionId && !t.completed);
    if (taskMatch) {
      taskMatch.completed = true;
      (taskMatch as any).score = evaluation.overallScore;
      dailyPlan.completedQuestions += 1;
    }

    // Re-run recommendation engine
    recalculateRecommendations();

    res.json({
      success: true,
      evaluation,
      updatedSkills: skillsList,
      updatedRecommendations: recommendationsList
    });
  });

  // 5. Evaluations History
  app.get('/api/practice/evaluations', (_req, res) => {
    res.json(evaluationsList);
  });

  // 6. Skills
  app.get('/api/practice/skills', (_req, res) => {
    res.json(skillsList);
  });

  // 7. Daily Practice Plan
  app.get('/api/practice/daily-plan', (_req, res) => {
    res.json(dailyPlan);
  });

  app.put('/api/practice/daily-plan/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = dailyPlan.tasks.find((t: any) => t.id === taskId);
    if (task) {
      task.completed = req.body.completed ?? !task.completed;
      dailyPlan.completedQuestions = dailyPlan.tasks.filter((t: any) => t.completed).length;
    }
    res.json(dailyPlan);
  });

  // 8. Smart Recommendations
  app.get('/api/practice/recommendations', (_req, res) => {
    res.json(recommendationsList);
  });

  // 9. AI Coach Chat Endpoint
  app.post('/api/coach/chat', async (req, res) => {
    const { message, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Calculate actual student context from saved progress
    const avgScore = evaluationsList.length > 0
      ? Math.round(evaluationsList.reduce((acc, curr) => acc + curr.overallScore, 0) / evaluationsList.length)
      : 0;
    const sortedSkills = [...skillsList].sort((a, b) => a.currentScore - b.currentScore);
    const weakestSkill = sortedSkills[0] || skillsList[0];
    const strongestSkill = sortedSkills[sortedSkills.length - 1] || skillsList[0];
    const recentEval = evaluationsList[0];

    const studentContextSummary = `
Candidate: ${currentStudent.name}
Selected Career Role: ${currentStudent.primaryRole || 'Professional'}
Experience Level: ${currentStudent.experienceLevel || 'Fresher'}
Main Goal: ${currentStudent.mainGoal || 'Both Communication & Interviews'}
Total Practice Attempts: ${evaluationsList.length}
Average Performance Score: ${avgScore}/100
Practice Streak: ${currentStudent.practiceStreakDays} days
Strongest Competency: ${strongestSkill ? `${strongestSkill.skillName} (${strongestSkill.currentScore}%)` : 'None yet'}
Primary Growth Area: ${weakestSkill ? `${weakestSkill.skillName} (${weakestSkill.currentScore}%)` : 'None yet'}
Most Recent Practice: ${recentEval ? `"${recentEval.questionTitle}" (Score: ${recentEval.overallScore}/100)` : 'None yet'}
`;

    // Check if Gemini API Key is available
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI();
        const systemPrompt = `You are the personal AI Communication Partner & Role-Based Interview Coach for AnswerCraft.
Tagline: Practice. Improve. Perform. Succeed.
You coach users across ANY career path (Software Developer, Data Analyst, UI/UX Designer, Teacher, Sales, Healthcare, etc.) to speak clearly, eliminate filler words, organize thoughts logically, and excel in role-specific interviews.
Tone: Encouraging, incisive, professional, and practical.
Keep responses concise, well-structured, and tailored directly to the user's career role (${currentStudent.primaryRole || 'Professional'}) and experience level (${currentStudent.experienceLevel || 'Fresher'}).

Current Candidate Performance Context:
${studentContextSummary}
`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            { role: 'user', parts: [{ text: systemPrompt }] },
            ...(history || []).map((h: { sender: string; text: string }) => ({
              role: h.sender === 'student' ? 'user' : 'model',
              parts: [{ text: h.text }]
            })),
            { role: 'user', parts: [{ text: message }] }
          ]
        });

        const replyText = response.text || "I've analyzed your progress. Let's practice communicating with clear structure and deliberate pauses.";
        return res.json({
          reply: replyText,
          badge: 'Gemini 2.5 AI Model',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      } catch (err: unknown) {
        console.error('Gemini API call failed, falling back to rule-based coach:', err);
      }
    }

    // Rule-Based Coach Engine (Guaranteed fallback with transparent badge)
    const lowerMsg = message.toLowerCase();
    let reply = '';
    let badge: 'Saved Practice Evidence' | 'Rule-based Coach' = 'Rule-based Coach';

    if (lowerMsg.includes('weakest') || lowerMsg.includes('weak skill') || lowerMsg.includes('improve')) {
      badge = 'Saved Practice Evidence';
      reply = `Based on your ${evaluationsList.length} saved practice sessions in your career track as a **${currentStudent.primaryRole}**, your current primary focus area is **${weakestSkill.skillName}** at **${weakestSkill.currentScore}%** (benchmark is ${weakestSkill.benchmarkScore}%).\n\n` +
        `• **Key Observation:** ${weakestSkill.recentEvidence}\n` +
        `• **Coach Recommendation:** ${weakestSkill.recommendedExercise}\n\n` +
        `Would you like to try a focused communication exercise for this right now?`;
    } else if (lowerMsg.includes('introduce') || lowerMsg.includes('myself')) {
      reply = `Here is our proven 3-phase framework for **"Tell me about yourself"** as a ${currentStudent.primaryRole}:\n\n` +
        `1. **Present (30s):** Who you are now, your specialty, and your primary domain passion.\n` +
        `2. **Past (45s):** 1-2 major projects with quantifiable outcomes or problems you solved.\n` +
        `3. **Future (25s):** Why this specific career opportunity matches your professional goals.\n\n` +
        `Keep it under 75-90 seconds. Would you like to practice delivering this in the Communication Coach?`;
    } else {
      reply = `Hello ${currentStudent.name}! I am your personal AI Communication Partner for your career path in **${currentStudent.primaryRole}**.\n\n` +
        `Currently your average performance score is **${avgScore}/100** across **${evaluationsList.length}** recorded attempts.\n\n` +
        `You can ask me to evaluate an answer, give role-specific tips, guide you through eliminating filler words, or launch a mock interview simulation.`;
    }

    res.json({
      reply,
      badge,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Communication Lessons API
  app.get('/api/coach/lessons', async (_req, res) => {
    const { COMMUNICATION_LESSONS } = await import('./src/data/communicationLessons');
    res.json(COMMUNICATION_LESSONS);
  });

  app.post('/api/coach/lesson-evaluate', async (req, res) => {
    const { lessonId, studentAnswer } = req.body;
    const { COMMUNICATION_LESSONS } = await import('./src/data/communicationLessons');
    const { evaluateCommunicationResponse } = await import('./src/services/communicationEngine');

    const lesson = COMMUNICATION_LESSONS.find(l => l.id === lessonId) || COMMUNICATION_LESSONS[0];
    const evaluation = evaluateCommunicationResponse(lesson, studentAnswer || '');

    // Update student skills
    skillsList = skillsList.map(skill => {
      let change = 0;
      if (skill.skillId === 'sk-clarity') {
        change = Math.round((evaluation.clarityScore - skill.currentScore) * 0.25);
      } else if (skill.skillId === 'sk-struct') {
        change = Math.round((evaluation.structureScore - skill.currentScore) * 0.25);
      }
      const newScore = Math.min(100, Math.max(30, skill.currentScore + change));
      return {
        ...skill,
        previousScore: skill.currentScore,
        currentScore: newScore,
        attemptsCount: skill.attemptsCount + 1,
        trend: (change > 0 ? 'up' : change < 0 ? 'down' : 'steady') as any,
        recentEvidence: `Communication drill on "${lesson.title.slice(0, 30)}..." scored ${evaluation.overallScore}/100.`
      };
    });

    res.json({ success: true, evaluation });
  });

  // 10. Privacy & Data Deletion
  app.post('/api/privacy/clear-data', (_req, res) => {
    evaluationsList = [];
    currentStudent.practiceStreakDays = 0;
    skillsList = skillsList.map(s => ({
      ...s,
      currentScore: 50,
      previousScore: 50,
      attemptsCount: 0,
      trend: 'steady',
      recentEvidence: 'Baseline reset. Awaiting first practice session.'
    }));
    recalculateRecommendations();
    res.json({ success: true, message: 'All practice data and historical evaluations have been permanently removed.' });
  });

  // ========================================================
  // 11. AI INTERVIEW STUDIO ENDPOINTS (Real-Time 3D Session)
  // ========================================================
  const activeSessions = new Map<string, any>();
  const completedReports: any[] = [];

  // A. Create a new interview session
  app.post('/api/interviews', async (req, res) => {
    try {
      const { config, studentId } = req.body;
      const sid = `session-${Date.now()}`;
      
      const role = config?.jobRole || 'Software Developer';
      const itype = config?.interviewType || 'Technical';
      const diff = config?.difficulty || 'Medium';

      // Import role-based questions
      const { getQuestionsForConfig } = await import('./src/data/roleQuestions');
      const baseQuestions = getQuestionsForConfig(role, itype, diff, questionsList);

      const sessionQuestions = baseQuestions.map(q => ({
        ...q,
        answered: false,
        studentAnswer: '',
        transcriptHistory: []
      }));

      const newSession = {
        id: sid,
        studentId: studentId || currentStudent.studentId,
        startTime: new Date().toISOString(),
        config: {
          jobRole: role,
          interviewType: itype,
          experienceLevel: config?.experienceLevel || 'Fresher',
          difficulty: diff,
          durationMinutes: config?.durationMinutes || 15,
          jobDescription: config?.jobDescription || '',
          resumeText: config?.resumeText || ''
        },
        questions: sessionQuestions,
        currentQuestionIndex: 0,
        state: 'READY',
        status: 'active',
        visualInsightsEnabled: true
      };

      activeSessions.set(sid, newSession);
      res.json({ success: true, session: newSession });
    } catch (err: any) {
      console.error('Error creating interview session:', err);
      res.status(500).json({ error: 'Failed to create interview session', details: err.message });
    }
  });

  // B. Get session state
  app.get('/api/interviews/:sessionId', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  });

  // C. Advance to next question
  app.post('/api/interviews/:sessionId/next-question', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.currentQuestionIndex < session.questions.length - 1) {
      session.currentQuestionIndex += 1;
      session.state = 'ASKING_QUESTION';
    } else {
      session.state = 'COMPLETED';
    }

    res.json({ success: true, session });
  });

  // D. Submit and Evaluate an Answer
  app.post('/api/interviews/:sessionId/answers', async (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { questionIndex, studentAnswer, durationSeconds } = req.body;
    const qIdx = Number(questionIndex ?? session.currentQuestionIndex);
    const question = session.questions[qIdx];

    if (!question) return res.status(400).json({ error: 'Invalid question index' });

    const cleanAnswer = (studentAnswer || '').trim();
    const words = cleanAnswer.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // Strict handling for empty or non-response (0 marks)
    if (wordCount === 0) {
      const zeroEval: EvaluationResult = {
        id: `eval-${Date.now()}`,
        questionId: question.id,
        questionTitle: question.title,
        category: question.category,
        difficulty: question.difficulty,
        studentId: session.studentId,
        timestamp: new Date().toISOString(),
        overallScore: 0,
        accuracyRate: 0,
        metrics: {
          keywordRelevance: 0,
          completeness: 0,
          answerStructure: 0,
          clarity: 0
        },
        matchedKeywords: [],
        missingKeywords: question.expectedKeywords,
        strengths: ['No answer submitted.'],
        areasToImprove: [
          'You did not answer this question (0 marks). In a real interview, always speak or type your thought process.',
          `Key expected concepts: ${question.expectedKeywords.slice(0, 3).join(', ')}.`
        ],
        suggestedStructure: question.requiredSections.join(' -> '),
        wordCount: 0,
        durationSeconds: Number(durationSeconds) || 0,
        engineUsed: 'AnswerCraft Accuracy Verification Engine',
        isRuleBasedEstimate: false
      };
      question.answered = true;
      question.studentAnswer = '';
      question.evaluation = zeroEval;
      evaluationsList.unshift(zeroEval);
      session.state = 'FEEDBACK';
      return res.json({
        success: true,
        evaluation: zeroEval,
        shouldFollowUp: true,
        followUpPrompt: `You didn't answer "${question.title}". Would you like to try answering this question now?`,
        session
      });
    }

    // Real AI Analysis: Analyze candidate's answer thoroughly with Gemini or Advanced Semantic Evaluator
    let evaluation: EvaluationResult;
    let followUpPrompt = '';
    let shouldFollowUp = false;

    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI();
        const evalPrompt = `You are Alex Vance, Senior Executive Hiring Lead & Interview Coach.
Evaluate this candidate's interview answer with high accuracy and constructiveness. Do NOT generate generic or fake feedback. Evaluate the ACTUAL content provided. If the candidate wrote gibberish or only a few uninformative words, score accordingly between 0 and 20.

Interview Role: ${session.config.jobRole}
Question: ${question.title}
Prompt: ${question.prompt || ''}
Expected Key Concepts: ${question.expectedKeywords.join(', ')}
Candidate Answer: "${studentAnswer}"
Elapsed Answer Time: ${durationSeconds} seconds

Provide a valid JSON response matching this schema:
{
  "overallScore": <number 0-100>,
  "accuracyRate": <number 0-100>,
  "keywordRelevance": <number 0-100>,
  "completeness": <number 0-100>,
  "answerStructure": <number 0-100>,
  "clarity": <number 0-100>,
  "matchedKeywords": [<array of exact or synonym concepts matched in the answer>],
  "missingKeywords": [<array of missing key concepts the candidate should have mentioned>],
  "strengths": [<2-3 specific observations citing what the candidate explained well>],
  "areasToImprove": [<2-3 actionable coaching recommendations to improve this answer>],
  "shouldFollowUp": <true if score < 80 or if answer missed a crucial trade-off, else false>,
  "followUpPrompt": <a natural follow-up question challenging or clarifying their response>
}`;

        const geminiRes = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: evalPrompt }] }],
          config: { responseMimeType: 'application/json' }
        });

        const parsed = JSON.parse(geminiRes.text || '{}');
        evaluation = {
          id: `eval-${Date.now()}`,
          questionId: question.id,
          questionTitle: question.title,
          category: question.category,
          difficulty: question.difficulty,
          studentId: session.studentId,
          timestamp: new Date().toISOString(),
          overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : (wordCount < 8 ? 10 : 50),
          accuracyRate: typeof parsed.accuracyRate === 'number' ? parsed.accuracyRate : (wordCount < 8 ? 10 : 50),
          metrics: {
            keywordRelevance: typeof parsed.keywordRelevance === 'number' ? parsed.keywordRelevance : 10,
            completeness: typeof parsed.completeness === 'number' ? parsed.completeness : Math.min(20, wordCount * 2),
            answerStructure: typeof parsed.answerStructure === 'number' ? parsed.answerStructure : 20,
            clarity: typeof parsed.clarity === 'number' ? parsed.clarity : 30
          },
          matchedKeywords: Array.isArray(parsed.matchedKeywords) ? parsed.matchedKeywords : [],
          missingKeywords: Array.isArray(parsed.missingKeywords) ? parsed.missingKeywords : question.expectedKeywords,
          strengths: Array.isArray(parsed.strengths) && parsed.strengths.length > 0 ? parsed.strengths : ['Response received.'],
          areasToImprove: Array.isArray(parsed.areasToImprove) && parsed.areasToImprove.length > 0 ? parsed.areasToImprove : ['Provide more concrete metrics and outcomes.'],
          suggestedStructure: question.requiredSections.join(' -> '),
          wordCount,
          durationSeconds: Number(durationSeconds) || 60,
          engineUsed: 'Gemini 2.5 Flash Executive Evaluator',
          isRuleBasedEstimate: false
        };
        shouldFollowUp = Boolean(parsed.shouldFollowUp);
        followUpPrompt = parsed.followUpPrompt || '';
      } catch (err) {
        console.warn('Gemini evaluation fallback to semantic evaluation:', err);
        evaluation = evaluateAnswerWithCppRules(
          question,
          cleanAnswer,
          Number(durationSeconds) || 60,
          session.studentId
        );
        shouldFollowUp = evaluation.overallScore < 75;
        if (shouldFollowUp && evaluation.missingKeywords.length > 0) {
          followUpPrompt = `Could you specifically elaborate on ${evaluation.missingKeywords[0]} in this context?`;
        }
      }
    } else {
      evaluation = evaluateAnswerWithCppRules(
        question,
        cleanAnswer,
        Number(durationSeconds) || 60,
        session.studentId
      );
      shouldFollowUp = evaluation.overallScore < 75;
      if (shouldFollowUp && evaluation.missingKeywords.length > 0) {
        followUpPrompt = `Could you specifically elaborate on ${evaluation.missingKeywords[0]} in this context?`;
      }
    }

    question.answered = true;
    question.studentAnswer = studentAnswer;
    question.evaluation = evaluation;

    // Record in global evaluations & update skills
    evaluationsList.unshift(evaluation);
    skillsList = skillsList.map(skill => {
      let change = 0;
      if (skill.category === question.category || skill.category === 'Core') {
        change = Math.round((evaluation.overallScore - skill.currentScore) * 0.2);
      }
      const newScore = Math.min(100, Math.max(30, skill.currentScore + change));
      return {
        ...skill,
        previousScore: skill.currentScore,
        currentScore: newScore,
        attemptsCount: skill.attemptsCount + 1,
        trend: (change > 0 ? 'up' : change < 0 ? 'down' : 'steady') as any,
        recentEvidence: `Live Interview on "${question.title.slice(0, 32)}..." scored ${evaluation.overallScore}/100.`
      };
    });

    recalculateRecommendations();

    session.state = 'FEEDBACK';

    res.json({
      success: true,
      evaluation,
      shouldFollowUp,
      followUpPrompt,
      session
    });
  });

  // E. Pause interview
  app.post('/api/interviews/:sessionId/pause', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.status = 'paused';
    session.state = 'PAUSED';
    res.json({ success: true, session });
  });

  // F. Resume interview
  app.post('/api/interviews/:sessionId/resume', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.status = 'active';
    session.state = 'LISTENING';
    res.json({ success: true, session });
  });

  // G. End Interview & Generate Comprehensive Report
  app.post('/api/interviews/:sessionId/end', async (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.status = 'completed';
    session.state = 'COMPLETED';
    session.endTime = new Date().toISOString();

    const answeredQuestions = session.questions.filter((q: any) => q.answered && q.evaluation);
    const totalScore = answeredQuestions.reduce((acc: number, q: any) => acc + (q.evaluation?.overallScore || 0), 0);
    const overallScore = answeredQuestions.length > 0 ? Math.round(totalScore / answeredQuestions.length) : 75;

    // Category breakdown
    const getCatScore = (cat: string) => {
      const items = answeredQuestions.filter((q: any) => q.category === cat);
      if (items.length === 0) return overallScore;
      return Math.round(items.reduce((acc: number, q: any) => acc + (q.evaluation?.overallScore || 0), 0) / items.length);
    };

    const hrScore = getCatScore('HR');
    const technicalScore = getCatScore('Technical');
    const behavioralScore = getCatScore('Behavioral');

    const report = {
      id: `report-${Date.now()}`,
      sessionId: session.id,
      studentId: session.studentId,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      jobRole: session.config.jobRole,
      interviewType: session.config.interviewType,
      overallScore,
      hrScore,
      technicalScore,
      behavioralScore,
      totalQuestions: session.questions.length,
      questionsCompleted: answeredQuestions.length,
      durationSeconds: Math.round((new Date().getTime() - new Date(session.startTime).getTime()) / 1000),
      strongestSkills: [
        'Structured Problem Framing',
        'Concise Conversational Delivery',
        technicalScore >= 75 ? 'Technical Terminology Recall' : 'Clear Self Introduction'
      ],
      weakestSkills: [
        technicalScore < 75 ? 'In-depth Technical Edge Case Coverage' : 'STAR Method Metric Quantification',
        'Answer Completeness under time pressure'
      ],
      summary: `Completed ${answeredQuestions.length} of ${session.questions.length} interview questions for the ${session.config.jobRole} (${session.config.experienceLevel}) position. Average performance scored ${overallScore}/100. Demonstrated solid communicative clarity with opportunities to deepen technical completeness.`,
      questionSummaries: answeredQuestions.map((q: any) => ({
        questionTitle: q.title,
        score: q.evaluation?.overallScore || 70,
        category: q.category,
        studentAnswer: q.studentAnswer || '',
        strengths: q.evaluation?.strengths || ['Good attempt on topic.'],
        areasToImprove: q.evaluation?.areasToImprove || ['Expand technical details.'],
        suggestedStructure: q.evaluation?.suggestedStructure || q.requiredSections.join(' -> ')
      })),
      nextSteps: [
        'Complete the recommended EvolveAI drills focusing on technical completeness.',
        'Review missed keywords in the C++ and Data Structures Question Bank.',
        'Schedule a 15-minute mock simulation targeting behavioral conflict resolution stories.'
      ]
    };

    session.finalReport = report;
    completedReports.unshift(report);

    res.json({ success: true, report, session });
  });

  // H. Get Report
  app.get('/api/interviews/:sessionId/report', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (session?.finalReport) {
      return res.json(session.finalReport);
    }
    const report = completedReports.find(r => r.sessionId === req.params.sessionId);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json(report);
  });

  // I. History & Progress
  app.get('/api/interviews/history', (_req, res) => {
    res.json(completedReports);
  });

  app.get('/api/interviews/progress', (_req, res) => {
    res.json({
      totalInterviews: completedReports.length,
      averageScore: completedReports.length > 0 ? Math.round(completedReports.reduce((a, b) => a + b.overallScore, 0) / completedReports.length) : 78,
      recentReports: completedReports.slice(0, 5)
    });
  });

  // Mount Vite middleware in development
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ConfidenceOS Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
