/**
 * Consistency Calendar Component
 * 
 * A beautiful calendar grid that displays workout completion consistency
 * with streak tracking and completion statistics.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native';

import { theme } from '../constants/theme';
import {
  CalendarDay,
  CompletionStats,
  StreakData,
  calculateStreak,
  generateMonthGrid,
  getMonthCompletions,
  getMonthlyStats
} from '../src/services/ProgressService';

interface ConsistencyCalendarProps {
  userId: string;
  onDayPress?: (date: string) => void;
  selectedDate?: string;
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ConsistencyCalendar: React.FC<ConsistencyCalendarProps> = ({ userId, onDayPress, selectedDate }) => {
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([]);
  const [streak, setStreak] = useState<StreakData>({ currentStreak: 0, longestStreak: 0 });
  const [stats, setStats] = useState<CompletionStats>({
    monthlyPercentage: 0,
    weeklyPercentage: 0,
    totalDaysCompleted: 0,
    totalDaysInPeriod: 0
  });
  const [loading, setLoading] = useState(true);

  // Load calendar data for current month
  const loadCalendarData = useCallback(async () => {
    try {
      setLoading(true);
      console.log(`Loading calendar data for ${currentYear}-${currentMonth}`);

      // Fetch completions and stats in parallel
      const [completionsResult, statsResult, streakResult] = await Promise.all([
        getMonthCompletions(userId, currentYear, currentMonth),
        getMonthlyStats(userId, currentYear, currentMonth),
        calculateStreak(userId)
      ]);

      if (completionsResult.error) {
        console.error('Error loading completions:', completionsResult.error);
        return;
      }

      if (statsResult.error) {
        console.error('Error loading stats:', statsResult.error);
        return;
      }

      if (streakResult.error) {
        console.error('Error loading streak:', streakResult.error);
        return;
      }

      // Generate calendar grid
      const grid = generateMonthGrid(currentYear, currentMonth, completionsResult.completions);
      setCalendarDays(grid);
      setStats(statsResult.stats);
      setStreak(streakResult.streak);

      console.log('Calendar data loaded successfully');
    } catch (error) {
      console.error('Error loading calendar data:', error);
    } finally {
      setLoading(false);
    }
  }, [userId, currentYear, currentMonth]);

  useEffect(() => {
    loadCalendarData();
  }, [loadCalendarData]);

  // Navigate to previous month
  const goToPreviousMonth = () => {
    if (currentMonth === 1) {
      setCurrentMonth(12);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  // Navigate to next month
  const goToNextMonth = () => {
    if (currentMonth === 12) {
      setCurrentMonth(1);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  // Get month name
  const getMonthName = (month: number) => {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return months[month - 1];
  };

  // Get day labels for calendar header
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color="#2E90FA" />
        <Text style={styles.loadingText}>Loading consistency data...</Text>
      </View>
    );
  }

  // Check if a date is today
  const isDateToday = (date: Date): boolean => {
    const today = new Date();
    // Compare using local date components to avoid timezone issues
    return date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
  };

  return (
    <View style={styles.container}>
      {/* Header with streak (only show if >= 3 days) */}
      {streak.currentStreak >= 3 && (
        <View style={styles.header}>
          <View style={styles.streakContainer}>
            <Text style={styles.streakText}>{streak.currentStreak} Day Streak</Text>
          </View>
        </View>
      )}

      {/* Calendar grid */}
      <View style={styles.calendarContainer}>
        {/* Day labels */}
        <View style={styles.dayLabelsRow}>
          {dayLabels.map((label, index) => (
            <Text key={index} style={styles.dayLabel}>{label}</Text>
          ))}
        </View>

        {/* Calendar grid - just circles */}
        <View style={styles.calendarGrid}>
          {calendarDays.map((day, index) => {
            const dateStr = toDateStr(day.date);
            const isSelected = selectedDate === dateStr;
            return (
              <Pressable
                key={index}
                style={styles.calendarCell}
                onPress={() => {
                  if (day.isCurrentMonth && onDayPress) onDayPress(dateStr);
                }}
                disabled={!day.isCurrentMonth || !onDayPress}
              >
                <View
                  style={[
                    styles.calendarCircle,
                    !day.isCurrentMonth && styles.calendarCircleHidden,
                    day.isCompleted && styles.calendarCircleFilled,
                    isDateToday(day.date) && styles.calendarCircleToday,
                    isSelected && styles.calendarCircleSelected,
                  ]}
                />
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'transparent',
    paddingHorizontal: 20,
    marginBottom: 0,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  loadingText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.regular,
    marginLeft: 8,
  },
  header: {
    marginBottom: 12,
  },
  streakContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakText: {
    color: theme.colors.primary,
    fontSize: theme.typography.fontSize.lg,
    fontFamily: theme.typography.fontFamily.bold,
  },
  monthHeader: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  monthTitle: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  calendarContainer: {
    marginBottom: 0,
  },
  dayLabelsRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  dayLabel: {
    flex: 1,
    textAlign: 'center',
    color: theme.colors.textMuted,
    fontSize: theme.typography.fontSize.xs,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarCell: {
    width: '14.28%', // 100% / 7 days
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  calendarCircle: {
    width: 12,
    height: 12,
    borderRadius: 8,
    backgroundColor: '#E5E5E5', // Lighter grey for dots
    borderWidth: 1,
    borderColor: '#E5E5E5', // Lighter grey for border
  },
  calendarCircleHidden: {
    opacity: 0,
  },
  calendarCircleFilled: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  calendarCircleToday: {
    borderWidth: 2,
    borderColor: theme.colors.primary,
  },
  calendarCircleSelected: {
    borderWidth: 2.5,
    borderColor: '#2E90FA',
    backgroundColor: 'rgba(0, 122, 255, 0.2)',
  },
});

export default ConsistencyCalendar;
