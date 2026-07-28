import { eq } from "drizzle-orm";
import type { BusinessHoursProfile } from "../../../core/scheduling/types.js";
import { generateId } from "../../../core/shared-kernel/ids.js";
import type {
  BusinessHoursProfileRepository,
  NewBusinessHoursProfileInput
} from "../../../ports/business-hours-profile-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { businessHoursProfiles } from "../schema.js";

type BusinessHoursProfileRow = typeof businessHoursProfiles.$inferSelect;

function toDomain(row: BusinessHoursProfileRow): BusinessHoursProfile {
  return { id: row.id, name: row.name, timezone: row.timezone, windows: row.windowsJson };
}

/** SQLite-backed implementation of BusinessHoursProfileRepository (Section 5.7). */
export class SqliteBusinessHoursProfileRepository implements BusinessHoursProfileRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewBusinessHoursProfileInput): Promise<BusinessHoursProfile> {
    const id = generateId();
    this.db
      .insert(businessHoursProfiles)
      .values({ id, name: input.name, timezone: input.timezone, windowsJson: input.windows })
      .run();
    const row = this.db.select().from(businessHoursProfiles).where(eq(businessHoursProfiles.id, id)).get();
    return toDomain(row!);
  }

  async findById(id: string): Promise<BusinessHoursProfile | undefined> {
    const row = this.db.select().from(businessHoursProfiles).where(eq(businessHoursProfiles.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async list(): Promise<BusinessHoursProfile[]> {
    return this.db.select().from(businessHoursProfiles).all().map(toDomain);
  }
}
