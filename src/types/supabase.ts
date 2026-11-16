// types/supabase.ts
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      active_workout_sessions: {
        Row: {
          current_exercise_index: number | null
          current_set: number | null
          difficulty: string | null
          estimated_time: number
          exercises: string[]
          exercises_structured: Json | null
          id: string
          is_resting: boolean | null
          rest_time_duration: number | null
          rest_time_remaining: number | null
          session_id: string | null
          sets_completed: Json | null
          started_at: string | null
          total_sets: number | null
          updated_at: string | null
          user_id: string
          workout_id: string | null
          workout_name: string
          workout_type: string
        }
        Insert: {
          current_exercise_index?: number | null
          current_set?: number | null
          difficulty?: string | null
          estimated_time: number
          exercises?: string[]
          exercises_structured?: Json | null
          id?: string
          is_resting?: boolean | null
          rest_time_duration?: number | null
          rest_time_remaining?: number | null
          session_id?: string | null
          sets_completed?: Json | null
          started_at?: string | null
          total_sets?: number | null
          updated_at?: string | null
          user_id: string
          workout_id?: string | null
          workout_name: string
          workout_type: string
        }
        Update: {
          current_exercise_index?: number | null
          current_set?: number | null
          difficulty?: string | null
          estimated_time?: number
          exercises?: string[]
          exercises_structured?: Json | null
          id?: string
          is_resting?: boolean | null
          rest_time_duration?: number | null
          rest_time_remaining?: number | null
          session_id?: string | null
          sets_completed?: Json | null
          started_at?: string | null
          total_sets?: number | null
          updated_at?: string | null
          user_id?: string
          workout_id?: string | null
          workout_name?: string
          workout_type?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string | null
          id: string
          metadata: Json | null
          role: string
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          role: string
          user_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      daily_workouts: {
        Row: {
          day_of_week: string
          estimated_time: number
          exercises: string[]
          exercises_structured: Json | null
          id: string
          notes: string | null
          plan_id: string
          split_day_name: string
        }
        Insert: {
          day_of_week: string
          estimated_time: number
          exercises?: string[]
          exercises_structured?: Json | null
          id?: string
          notes?: string | null
          plan_id: string
          split_day_name: string
        }
        Update: {
          day_of_week?: string
          estimated_time?: number
          exercises?: string[]
          exercises_structured?: Json | null
          id?: string
          notes?: string | null
          plan_id?: string
          split_day_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_workouts_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "user_active_workout_plan"
            referencedColumns: ["plan_id"]
          },
          {
            foreignKeyName: "daily_workouts_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "user_main_workout_plan"
            referencedColumns: ["plan_id"]
          },
          {
            foreignKeyName: "daily_workouts_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "workout_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      exercise_performance: {
        Row: {
          comment: string | null
          created_at: string | null
          exercise_name: string
          id: string
          reps_completed: number
          set_number: number
          user_id: string
          weight_used: number | null
          workout_date: string | null
        }
        Insert: {
          comment?: string | null
          created_at?: string | null
          exercise_name: string
          id?: string
          reps_completed: number
          set_number: number
          user_id: string
          weight_used?: number | null
          workout_date?: string | null
        }
        Update: {
          comment?: string | null
          created_at?: string | null
          exercise_name?: string
          id?: string
          reps_completed?: number
          set_number?: number
          user_id?: string
          weight_used?: number | null
          workout_date?: string | null
        }
        Relationships: []
      }
      exercises: {
        Row: {
          body_part: string | null
          category: string | null
          description: string | null
          difficulty: string | null
          embedding: string | null
          equipment: string | null
          gif_path: string | null
          id: string
          instructions: string[] | null
          name: string
          secondary_muscles: string[] | null
          target_muscle: string | null
        }
        Insert: {
          body_part?: string | null
          category?: string | null
          description?: string | null
          difficulty?: string | null
          embedding?: string | null
          equipment?: string | null
          gif_path?: string | null
          id: string
          instructions?: string[] | null
          name: string
          secondary_muscles?: string[] | null
          target_muscle?: string | null
        }
        Update: {
          body_part?: string | null
          category?: string | null
          description?: string | null
          difficulty?: string | null
          embedding?: string | null
          equipment?: string | null
          gif_path?: string | null
          id?: string
          instructions?: string[] | null
          name?: string
          secondary_muscles?: string[] | null
          target_muscle?: string | null
        }
        Relationships: []
      }
      nutrition_logs: {
        Row: {
          calories: number
          carbs: number
          created_at: string
          date: string
          fats: number
          id: string
          protein: number
          raw_text: string
          user_id: string
        }
        Insert: {
          calories: number
          carbs: number
          created_at?: string
          date?: string
          fats: number
          id?: string
          protein: number
          raw_text: string
          user_id: string
        }
        Update: {
          calories?: number
          carbs?: number
          created_at?: string
          date?: string
          fats?: number
          id?: string
          protein?: number
          raw_text?: string
          user_id?: string
        }
        Relationships: []
      }
      saved_workouts: {
        Row: {
          created_at: string | null
          description: string | null
          difficulty: string | null
          estimated_time: number
          exercises: string[]
          exercises_structured: Json | null
          id: string
          note: string | null
          replacement_date: string | null
          replacement_for: string | null
          updated_at: string | null
          user_id: string
          workout_name: string
          workout_type: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          difficulty?: string | null
          estimated_time: number
          exercises?: string[]
          exercises_structured?: Json | null
          id?: string
          note?: string | null
          replacement_date?: string | null
          replacement_for?: string | null
          updated_at?: string | null
          user_id: string
          workout_name: string
          workout_type: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          difficulty?: string | null
          estimated_time?: number
          exercises?: string[]
          exercises_structured?: Json | null
          id?: string
          note?: string | null
          replacement_date?: string | null
          replacement_for?: string | null
          updated_at?: string | null
          user_id?: string
          workout_name?: string
          workout_type?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          available_equipment: string[]
          birthday: string
          created_at: string | null
          custom_split: Json | null
          fitness_level: string
          gender: string
          goal: string
          goal_weight_kg: number
          height_cm: number
          height_unit: string | null
          id: string
          injuries: string | null
          location: string
          name: string
          notification_permission_requested: boolean | null
          notifications_enabled: boolean | null
          onboarding_completed: boolean | null
          onboarding_questions_completed: boolean | null
          pace: string
          selected_workout_days: Json | null
          updated_at: string | null
          weight_kg: number
          weight_unit: string
          workout_days_per_week: number
          workout_duration_minutes: number
          workout_split_type: string
        }
        Insert: {
          available_equipment?: string[]
          birthday: string
          created_at?: string | null
          custom_split?: Json | null
          fitness_level: string
          gender: string
          goal: string
          goal_weight_kg: number
          height_cm: number
          height_unit?: string | null
          id: string
          injuries?: string | null
          location: string
          name: string
          notification_permission_requested?: boolean | null
          notifications_enabled?: boolean | null
          onboarding_completed?: boolean | null
          onboarding_questions_completed?: boolean | null
          pace: string
          selected_workout_days?: Json | null
          updated_at?: string | null
          weight_kg: number
          weight_unit?: string
          workout_days_per_week: number
          workout_duration_minutes: number
          workout_split_type: string
        }
        Update: {
          available_equipment?: string[]
          birthday?: string
          created_at?: string | null
          custom_split?: Json | null
          fitness_level?: string
          gender?: string
          goal?: string
          goal_weight_kg?: number
          height_cm?: number
          height_unit?: string | null
          id?: string
          injuries?: string | null
          location?: string
          name?: string
          notification_permission_requested?: boolean | null
          notifications_enabled?: boolean | null
          onboarding_completed?: boolean | null
          onboarding_questions_completed?: boolean | null
          pace?: string
          selected_workout_days?: Json | null
          updated_at?: string | null
          weight_kg?: number
          weight_unit?: string
          workout_days_per_week?: number
          workout_duration_minutes?: number
          workout_split_type?: string
        }
        Relationships: []
      }
      workout_completions: {
        Row: {
          completed_at: string | null
          completion_date: string
          id: string
          user_id: string
          workout_type: string
        }
        Insert: {
          completed_at?: string | null
          completion_date: string
          id?: string
          user_id: string
          workout_type: string
        }
        Update: {
          completed_at?: string | null
          completion_date?: string
          id?: string
          user_id?: string
          workout_type?: string
        }
        Relationships: []
      }
      workout_plans: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          plan_name: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          plan_name: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          plan_name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workout_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      conversation_summaries: {
        Row: {
          conversation_id: string | null
          first_user_message: string | null
          last_message_at: string | null
          message_count: number | null
          started_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      user_active_workout_plan: {
        Row: {
          day_of_week: string | null
          estimated_time: number | null
          exercises: string[] | null
          exercises_structured: Json | null
          notes: string | null
          plan_created_at: string | null
          plan_id: string | null
          plan_name: string | null
          split_day_name: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workout_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_all_workouts: {
        Row: {
          created_at: string | null
          description: string | null
          difficulty: string | null
          estimated_time: number | null
          exercises: string[] | null
          exercises_structured: Json | null
          id: string | null
          source: string | null
          user_id: string | null
          workout_name: string | null
          workout_type: string | null
        }
        Relationships: []
      }
      user_main_workout_plan: {
        Row: {
          created_at: string | null
          plan_id: string | null
          plan_name: string | null
          user_id: string | null
          weekly_schedule: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "workout_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      cleanup_old_workout_sessions: { Args: never; Returns: undefined }
      delete_user: { Args: never; Returns: undefined }
      set_user_timezone: { Args: { p_timezone: string }; Returns: undefined }
      search_exercises: {
        Args: {
          equipment_filter?: string[]
          match_count?: number
          query_text?: string
          query_embedding: string
        }
        Returns: {
          body_part: string
          difficulty: string
          gif_path: string
          equipment: string
          id: string
          instructions: string[]
          name: string
          similarity: number
          target_muscle: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
