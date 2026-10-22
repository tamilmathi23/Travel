import { GoogleGenAI } from '@google/genai';
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { TripPlanRequest, TripPlanResult, ItineraryDay } from './src/types/travel.ts';
import { getSafetyForDestination } from './src/data/safetyData.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

// Shared server-side Gemini client
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

async function startServer() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', hasGeminiKey: Boolean(apiKey) });
  });

  // Safety Profile Endpoint
  app.get('/api/safety/:destination', (req: Request, res: Response) => {
    const destination = req.params.destination || 'Tokyo';
    const safety = getSafetyForDestination(destination);
    res.json(safety);
  });

  // AI Trip Planning Endpoint
  app.post('/api/plan-trip', async (req: Request, res: Response) => {
    const tripReq: TripPlanRequest = req.body;

    if (!tripReq.destination) {
      return res.status(400).json({ error: 'Destination is required' });
    }

    const safety = getSafetyForDestination(tripReq.destination);

    // Compute number of days between dates
    const start = tripReq.startDate ? new Date(tripReq.startDate) : new Date();
    const end = tripReq.endDate ? new Date(tripReq.endDate) : new Date(start.getTime() + 4 * 86400000);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const daysCount = Math.max(1, Math.min(10, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1));

    if (ai) {
      try {
        const genderPrefInfo = tripReq.genderPreferences?.enabled
          ? `User requested optional travel personalization preferences:
- Women-focused recommendations: ${tripReq.genderPreferences.womenFocusedRecommendations ? 'YES' : 'NO'}
- Women solo-safety guidance: ${tripReq.genderPreferences.womenSoloSafetyGuidance ? 'YES' : 'NO'}
- LGBTQ+-friendly businesses & safe spaces: ${tripReq.genderPreferences.lgbtqFriendlyBusinesses ? 'YES' : 'NO'}
- Family-friendly travel guidance: ${tripReq.genderPreferences.familyFriendlyGuidance ? 'YES' : 'NO'}
- Custom comfort: ${(tripReq.genderPreferences.customComfortPreferences || []).join(', ') || 'None'}
Please integrate these thoughtfully without stereotyping or restricting activities.`
          : 'Standard travel recommendations without gender-specific filters.';

        const prompt = `You are Travel AI, an expert travel planner and safety assistant.
Generate a realistic, detailed, high-quality travel itinerary in JSON format for the following trip:
- Origin: ${tripReq.origin || 'Flexible'}
- Destination: ${tripReq.destination}
- Duration: ${daysCount} days (from ${tripReq.startDate || 'Day 1'} to ${tripReq.endDate || `Day ${daysCount}`})
- Travelers: ${tripReq.travelersCount || 1}
- Total Budget: ${tripReq.budget || 1500} ${tripReq.currency || 'USD'}
- Travel Style: ${tripReq.travelStyle || 'cultural'}
- Accommodation Preference: ${tripReq.accommodationType || 'boutique_hotel'}
- Transportation Preference: ${tripReq.transportPreference || 'public_transit'}
- Dietary Requirements: ${(tripReq.dietaryRequirements || []).join(', ') || 'None specified'}
- Accessibility Requirements: ${(tripReq.accessibilityRequirements || []).join(', ') || 'Standard step-free preferences'}
- ${genderPrefInfo}
${tripReq.additionalNotes ? `Additional Traveler Notes: ${tripReq.additionalNotes}` : ''}

Output MUST be a valid JSON object strictly matching this TypeScript structure:
{
  "title": string,
  "summary": string,
  "days": [
    {
      "dayNumber": number (1 to ${daysCount}),
      "date": string,
      "theme": string,
      "neighborhood": string,
      "dailyEstimatedCost": number,
      "eveningSafetyTip": string,
      "activities": [
        {
          "id": string,
          "time": string (e.g. "09:00 AM"),
          "activityName": string,
          "location": string,
          "address": string,
          "duration": string (e.g. "2 hours"),
          "estimatedCost": number,
          "transportMethod": string,
          "transportDuration": string,
          "mealRecommendation": string (if meal stop),
          "safetyNotes": string,
          "accessibilityNotes": string,
          "whyItMatches": string,
          "category": "attraction" | "food" | "culture" | "nature" | "leisure" | "transport"
        }
      ]
    }
  ],
  "budgetBreakdown": [
    { "category": "Flights / Long-distance Transit", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Accommodation", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Food & Dining", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Activities & Attractions", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Local Transportation", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Shopping & Souvenirs", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Travel Insurance & Medical", "estimatedCost": number, "percentage": number, "notes": string },
    { "category": "Emergency Reserve", "estimatedCost": number, "percentage": number, "notes": string }
  ],
  "recommendations": [
    {
      "id": string,
      "name": string,
      "category": "hotel" | "restaurant" | "attraction" | "tour" | "transit",
      "rating": number (e.g. 4.8),
      "priceLevel": "$" | "$$" | "$$$" | "$$$$",
      "estimatedCost": number,
      "address": string,
      "description": string,
      "whyItMatches": string,
      "tags": string[],
      "safetyHighlight": string,
      "accessibilityHighlight": string
    }
  ]
}

Ensure all costs are in ${tripReq.currency || 'USD'} and the sum of daily activities and accommodations aligns with the user's budget.
Provide realistic neighborhood names and authentic venues.
Return strictly valid JSON only.`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.7,
            systemInstruction:
              'You are Travel AI, an objective, respectful, inclusive, and accurate travel planning engine. Never fabricate unverified facts, always calculate coherent budgets, and respect traveler dignity across all demographics.',
          },
        });

        const rawText = response.text || '{}';
        const parsedData = JSON.parse(rawText);

        const totalCost = (parsedData.budgetBreakdown || []).reduce(
          (acc: number, item: { estimatedCost: number }) => acc + (item.estimatedCost || 0),
          0
        );

        const result: TripPlanResult = {
          id: `trip-${Date.now()}`,
          title: parsedData.title || `Curated Journey to ${tripReq.destination}`,
          destination: tripReq.destination,
          origin: tripReq.origin || 'Origin City',
          startDate: tripReq.startDate || new Date().toISOString().split('T')[0],
          endDate: tripReq.endDate || new Date(Date.now() + daysCount * 86400000).toISOString().split('T')[0],
          daysCount,
          travelersCount: tripReq.travelersCount || 1,
          currency: tripReq.currency || 'USD',
          totalEstimatedCost: totalCost || tripReq.budget,
          allocatedBudget: tripReq.budget,
          budgetStatus:
            totalCost <= tripReq.budget
              ? 'within_budget'
              : totalCost <= tripReq.budget * 1.15
              ? 'near_budget'
              : 'exceeds_budget',
          summary:
            parsedData.summary ||
            `Personalized ${daysCount}-day travel plan for ${tripReq.destination} matching your ${tripReq.travelStyle} travel style and safety preferences.`,
          days: parsedData.days || [],
          budgetBreakdown: parsedData.budgetBreakdown || [],
          recommendations: parsedData.recommendations || [],
          safetyProfile: safety,
          createdAt: new Date().toISOString(),
          userNotes: tripReq.additionalNotes,
        };

        return res.json(result);
      } catch (geminiError) {
        console.warn('Gemini generateContent error, activating high-fidelity deterministic fallback:', geminiError);
      }
    }

    // High-fidelity fallback generation if key is unconfigured or transient error occurs
    const fallbackResult = generateFallbackTrip(tripReq, daysCount, safety);
    return res.json(fallbackResult);
  });

  // AI Chat Assistant Endpoint
  app.post('/api/chat', async (req: Request, res: Response) => {
    const { message, history, destination } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (ai) {
      try {
        const destinationContext = destination ? `Current destination focus: ${destination}.` : '';
        const systemPrompt = `You are Travel AI Assistant, a world-class travel advisor specializing in personalized, safe, and inclusive travel planning.
${destinationContext}
Core Principles:
1. Provide thoughtful, actionable, and culturally respectful advice.
2. Adapt seamlessly to solo travelers, women travelers, LGBTQ+ travelers, and families when asked.
3. Be transparent about safety without being alarmist: distinguish between verified municipal facts and general advice.
4. Keep budget realities front and center.
5. Never invent fake flight numbers or fake hotel reservation confirmations.
6. Provide concise, clear answers with 2-3 bulleted highlights when helpful.
7. End your response with 3 clickable suggested follow-up prompts formatted as:
[SUGGESTIONS: "Prompt 1", "Prompt 2", "Prompt 3"]`;

        // Assemble contents with history if available
        let contents = message;
        if (Array.isArray(history) && history.length > 0) {
          const formattedHistory = history
            .map((h: { role: string; content: string }) => `${h.role === 'user' ? 'Traveler' : 'Travel AI'}: ${h.content}`)
            .join('\n');
          contents = `Conversation history:\n${formattedHistory}\n\nTraveler: ${message}`;
        }

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
          },
        });

        const replyText = response.text || 'I am ready to help you plan your journey. Where are you headed next?';

        // Extract suggestions if model appended them
        const suggestionsMatch = replyText.match(/\[SUGGESTIONS:\s*(.*?)\]/s);
        let cleanedReply = replyText;
        let suggestions: string[] = [
          'What are the safest neighborhoods to stay in?',
          'How can I optimize my daily food and transit budget?',
          'Find women-led walking tours and inclusive cafes',
        ];

        if (suggestionsMatch && suggestionsMatch[1]) {
          cleanedReply = replyText.replace(suggestionsMatch[0], '').trim();
          try {
            suggestions = JSON.parse(`[${suggestionsMatch[1]}]`);
          } catch {
            // keep default suggestions
          }
        }

        return res.json({
          reply: cleanedReply,
          suggestions,
        });
      } catch (chatError) {
        console.warn('Gemini chat error, returning assisted response:', chatError);
      }
    }

    // Deterministic fallback response for conversational queries
    const fallbackResponse = getFallbackChatResponse(message, destination);
    return res.json(fallbackResponse);
  });

  // Setup Vite or static serving
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Travel AI server listening on http://0.0.0.0:${PORT}`);
  });
}

// Deterministic generator ensuring robust zero-failure experience
function generateFallbackTrip(req: TripPlanRequest, daysCount: number, safety: any): TripPlanResult {
  const dest = req.destination;
  const curr = req.currency || 'USD';
  const totalBudget = req.budget || 1400;

  const sampleThemes = [
    { theme: 'Historic Arrival & Neighborhood Orientation', neighborhood: 'Central Heritage Quarter' },
    { theme: 'Artisan Markets & Cultural Highlights', neighborhood: 'Arts & Design District' },
    { theme: 'Culinary Discoveries & Local Gastronomy', neighborhood: 'Historic Food Hall Quarter' },
    { theme: 'Architectural Landmarks & Scenic Overlooks', neighborhood: 'Panoramic Hillside' },
    { theme: 'Hidden Gems & Waterfront Stroll', neighborhood: 'Coastal / Riverfront Promenade' },
  ];

  const days: ItineraryDay[] = [];
  const dailyCost = Math.round(totalBudget * 0.45 / daysCount);

  for (let i = 1; i <= daysCount; i++) {
    const themeIdx = (i - 1) % sampleThemes.length;
    const t = sampleThemes[themeIdx];

    const dayActivities = [
      {
        id: `act-${i}-1`,
        time: '09:00 AM',
        activityName: `Morning Walk through ${t.neighborhood}`,
        location: `${dest} Main Plaza`,
        address: `12 Heritage Avenue, ${dest}`,
        duration: '2.5 hours',
        estimatedCost: Math.round(dailyCost * 0.2),
        currency: curr,
        transportMethod: req.transportPreference === 'walking' ? 'Walking' : 'Metro / Light Rail',
        transportDuration: '15 mins',
        safetyNotes: 'Well-lit pedestrian corridor with active morning foot traffic.',
        accessibilityNotes: 'Step-free sidewalks with curb cuts.',
        whyItMatches: 'Perfect introduction to local architecture and community life.',
        category: 'culture' as const,
      },
      {
        id: `act-${i}-2`,
        time: '12:30 PM',
        activityName: 'Curated Lunch at Local Cooperative Bistro',
        location: `${dest} Culinary Market`,
        address: `Market Hall, ${dest}`,
        duration: '1.5 hours',
        estimatedCost: Math.round(dailyCost * 0.35),
        currency: curr,
        transportMethod: 'Short walk',
        transportDuration: '8 mins',
        mealRecommendation: 'Locally sourced seasonal specialty with vegetarian & allergen-friendly options',
        safetyNotes: 'Lively, friendly atmosphere with visible kitchen hygiene standards.',
        accessibilityNotes: 'Ground floor accessible seating.',
        whyItMatches: 'Supports independent, inclusive local food artisans.',
        category: 'food' as const,
      },
      {
        id: `act-${i}-3`,
        time: '03:00 PM',
        activityName: `Exploration of ${dest} Premier Cultural Museum`,
        location: `${dest} Arts Center`,
        address: `45 Culture Way, ${dest}`,
        duration: '2.5 hours',
        estimatedCost: Math.round(dailyCost * 0.25),
        currency: curr,
        transportMethod: 'Public Transit',
        transportDuration: '12 mins',
        safetyNotes: 'Secure bag check and verified licensed guides.',
        accessibilityNotes: 'Elevators and tactile museum paths available.',
        whyItMatches: 'Deep immersion into regional heritage and artistic movements.',
        category: 'attraction' as const,
      },
      {
        id: `act-${i}-4`,
        time: '07:30 PM',
        activityName: 'Sunset Dinner & Twilight Stroll',
        location: `${dest} Promenade`,
        address: `Waterfront Walk, ${dest}`,
        duration: '2 hours',
        estimatedCost: Math.round(dailyCost * 0.2),
        currency: curr,
        transportMethod: 'Licensed Taxi / Rideshare',
        transportDuration: '10 mins',
        mealRecommendation: 'Atmospheric family-owned café with outdoor illuminated terrace',
        safetyNotes: 'Stick to illuminated central boulevards; request hotel-approved taxi if returning late.',
        accessibilityNotes: 'Flat paved promenade.',
        whyItMatches: 'Relaxed, scenic evening ambiance without overwhelming crowds.',
        category: 'leisure' as const,
      },
    ];

    days.push({
      dayNumber: i,
      date: `Day ${i}`,
      theme: t.theme,
      neighborhood: t.neighborhood,
      dailyEstimatedCost: dailyCost,
      eveningSafetyTip:
        'Keep phone charged and save offline maps. Use verified ride-hail apps or licensed taxi stands when traveling after 10:00 PM.',
      activities: dayActivities,
    });
  }

  const budgetBreakdown = [
    {
      category: 'Flights / Long-Distance Transit',
      estimatedCost: Math.round(totalBudget * 0.28),
      percentage: 28,
      notes: 'Estimated roundtrip economy fares with flexible cancellation',
    },
    {
      category: 'Accommodation',
      estimatedCost: Math.round(totalBudget * 0.32),
      percentage: 32,
      notes: 'Well-reviewed central property with 24h desk security',
    },
    {
      category: 'Food & Dining',
      estimatedCost: Math.round(totalBudget * 0.18),
      percentage: 18,
      notes: 'Breakfast, market lunches, and evening dining',
    },
    {
      category: 'Activities & Attractions',
      estimatedCost: Math.round(totalBudget * 0.1),
      percentage: 10,
      notes: 'Museum passes, monument tickets, and walking tours',
    },
    {
      category: 'Local Transportation',
      estimatedCost: Math.round(totalBudget * 0.05),
      percentage: 5,
      notes: 'Multi-day metro cards and occasional rideshare',
    },
    {
      category: 'Travel Insurance & Health',
      estimatedCost: Math.round(totalBudget * 0.04),
      percentage: 4,
      notes: 'Comprehensive medical and trip delay coverage',
    },
    {
      category: 'Emergency Reserve',
      estimatedCost: Math.round(totalBudget * 0.03),
      percentage: 3,
      notes: 'Flexible contingency buffer',
    },
  ];

  const recommendations = [
    {
      id: 'rec-hotel-1',
      name: `${dest} Central Heritage Boutique Hotel`,
      category: 'hotel' as const,
      rating: 4.8,
      priceLevel: '$$' as const,
      estimatedCost: Math.round(totalBudget * 0.32 / daysCount),
      address: `15 Sanctuary Street, ${dest}`,
      description: 'Charming boutique accommodation with 24-hour reception, keycard-restricted floor access, and high guest safety ratings.',
      whyItMatches: 'Central, well-lit location near public transit with verified solo traveler satisfaction.',
      tags: ['24/7 Desk', 'Solo-Friendly', 'Elevator Access', 'Central'],
      safetyHighlight: 'Staff on duty around the clock; well-illuminated main street entrance.',
      accessibilityHighlight: 'Step-free entryway and spacious elevator.',
    },
    {
      id: 'rec-dining-1',
      name: `${dest} Artisan Kitchen & Café`,
      category: 'restaurant' as const,
      rating: 4.9,
      priceLevel: '$$' as const,
      estimatedCost: 28,
      address: `8 Botanica Way, ${dest}`,
      description: 'Inclusive community-oriented café serving organic regional dishes, specialty coffee, and local specialties.',
      whyItMatches: 'Welcoming atmosphere for solo diners and diverse traveler backgrounds.',
      tags: ['Vegetarian Options', 'Inclusive', 'Solo Dining Counters', 'WiFi'],
      safetyHighlight: 'Warm, respectful staff with zero-harassment community policy.',
      accessibilityHighlight: 'Level street entrance and accessible restroom.',
    },
    {
      id: 'rec-tour-1',
      name: `Historic ${dest} Small Group Walking Tour`,
      category: 'tour' as const,
      rating: 4.9,
      priceLevel: '$' as const,
      estimatedCost: 35,
      address: `Starts at Central Clocktower, ${dest}`,
      description: 'Led by certified local historians sharing architectural lore, community culture, and practical safety tips.',
      whyItMatches: 'Ideal way for solo travelers to meet fellow travelers while learning city navigation.',
      tags: ['Small Group', 'Certified Guide', 'Daytime', 'Social'],
      safetyHighlight: 'Pre-registered groups with dedicated meeting points and emergency contact check-in.',
      accessibilityHighlight: 'Paved, gradual walking paths with regular rest stops.',
    },
  ];

  return {
    id: `trip-${Date.now()}`,
    title: `${daysCount}-Day Curated Journey to ${dest}`,
    destination: dest,
    origin: req.origin || 'Home',
    startDate: req.startDate || new Date().toISOString().split('T')[0],
    endDate: req.endDate || new Date(Date.now() + daysCount * 86400000).toISOString().split('T')[0],
    daysCount,
    travelersCount: req.travelersCount || 1,
    currency: curr,
    totalEstimatedCost: totalBudget,
    allocatedBudget: totalBudget,
    budgetStatus: 'within_budget',
    summary: `Your personalized ${daysCount}-day itinerary for ${dest} combines cultural landmarks, authentic neighborhood cuisine, vetted safe accommodations, and budget-conscious transit.`,
    days,
    budgetBreakdown,
    recommendations,
    safetyProfile: safety,
    createdAt: new Date().toISOString(),
    userNotes: req.additionalNotes,
  };
}

function getFallbackChatResponse(message: string, destination?: string) {
  const lower = message.toLowerCase();
  const destName = destination || 'your destination';

  if (lower.includes('alone') || lower.includes('solo') || lower.includes('women')) {
    return {
      reply: `When traveling solo to ${destName}, here are proven safety and comfort strategies:
• **Accommodation:** Prioritize hotels or boutique hostels featuring 24/7 manned front desks, interior corridor access, and verified reviews from other solo travelers.
• **Navigation:** Download offline map zones on Google Maps or Apple Maps before you depart your accommodation so you never appear lost on street corners.
• **Arrival Times:** Aim to arrive during daylight hours (before 6:00 PM) to comfortably navigate from the airport/station to your hotel.
• **Connecting Safely:** Join small-group daytime walking or cooking tours to socialize with fellow travelers without compromising personal boundaries.`,
      suggestions: [
        'Recommend safe accommodations with 24/7 reception',
        'What are the best solo-friendly dining spots?',
        'Emergency contacts and transit safety checklist',
      ],
    };
  }

  if (lower.includes('lgbtq') || lower.includes('queer') || lower.includes('pride')) {
    return {
      reply: `For LGBTQ+ travelers visiting ${destName}:
• **Legal & Social Climate:** Check national laws and local municipal attitudes. In progressive hubs like Tokyo (Shinjuku Ni-chome), Reykjavik, and Lisbon (Príncipe Real), travelers enjoy welcoming, affirmative communities.
• **Safe Hubs & Venues:** Look for venues affiliated with the International LGBTQ+ Travel Association (IGLTA) and community cultural centers.
• **Discretion Guidance:** In jurisdictions with differing social customs, research public display of affection norms which may apply to all travelers equally.`,
      suggestions: [
        'Top LGBTQ+-friendly cafes and bookstores',
        'Local community resources and emergency numbers',
        'Best inclusive neighborhoods to stay in',
      ],
    };
  }

  if (lower.includes('budget') || lower.includes('cost') || lower.includes('cheap')) {
    return {
      reply: `To optimize your travel budget for ${destName}:
• **Transit:** Purchase 24h or multi-day public transit passes instead of single tickets or taxis.
• **Dining:** Make lunch your main dining experience at local food halls or neighborhood bistros, which frequently offer daily set menus (Menu del Día) at half the evening dinner cost.
• **Museums:** Research free admission days (many municipal cultural institutions offer free entry on the first Sunday of the month or after 4:00 PM).
• **Accommodation:** Staying 2–3 metro stops outside the ultra-touristy center often reduces lodging expenses by 30–40% without compromising safety.`,
      suggestions: [
        'Calculate a daily spending breakdown',
        'Find free cultural attractions and parks',
        'How much should I reserve for emergencies?',
      ],
    };
  }

  return {
    reply: `I can help you plan every detail of your trip to ${destName}! Whether you need a day-by-day itinerary, neighborhood safety analysis, budget breakdown, or recommendations tailored to your travel style, just let me know what you would like to explore.`,
    suggestions: [
      'Generate a personalized 5-day itinerary',
      'What are the official travel advisories and scams to avoid?',
      'Suggest hotels with excellent safety ratings',
    ],
  };
}

startServer().catch((err) => {
  console.error('Failed to start Travel AI server:', err);
});
