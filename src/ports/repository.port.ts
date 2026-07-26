/** Generic persistence port. Concrete SQL repositories live in adapters/persistence (Section 4). */
export interface Repository<T, Id> {
  findById(id: Id): Promise<T | undefined>;
  save(entity: T): Promise<void>;
  delete(id: Id): Promise<void>;
}
