package postgres

import (
	"fmt"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Service interface {
	RunMigrations(models []interface{})

	Find(model interface{}, conds ...interface{}) error
	GetOrCreate(result, object interface{}) error
	Insert(objects interface{}) error
	Upsert(objects interface{}, conflictColumns ...string) error
	Transaction(fn func(tx Service) error) error
}

func NewService(
	config map[string]interface{},
	logger logger.Logger,
) Service {
	service := &service{
		logger: logger,
		db: connect(
			logger,
			config["postgres_user"].(string),
			config["postgres_password"].(string),
			config["postgres_host"].(string),
			config["postgres_port"].(string),
			config["postgres_database"].(string),
		),
	}

	return service
}

type service struct {
	logger logger.Logger

	db *gorm.DB
}

func (this service) Insert(objects interface{}) error {
	return this.db.Create(objects).Error
}

// Upsert inserts objects, updating all non-key columns on conflict;
// conflictColumns defaults to the primary key. Structs only, not maps.
func (this service) Upsert(objects interface{}, conflictColumns ...string) error {
	onConflict := clause.OnConflict{UpdateAll: true}
	for _, col := range conflictColumns {
		onConflict.Columns = append(onConflict.Columns, clause.Column{Name: col})
	}

	return this.db.Clauses(onConflict).Create(objects).Error
}

func (this service) GetOrCreate(result, conditions interface{}) error {
	err := this.db.FirstOrCreate(result, conditions).Error
	if err != nil {
		this.logger.Error(
			"GetOrCreate",
			"error", err,
		)

		return err
	}

	return nil
}

func (this service) Find(model interface{}, conds ...interface{}) error {
	return this.db.Find(model, conds...).Error
}

// Transaction runs fn atomically; use fn's tx-bound Service inside the
// callback. Nested calls run in savepoints (mongo forbids nesting).
func (this service) Transaction(fn func(tx Service) error) error {
	return this.db.Transaction(func(txDB *gorm.DB) error {
		return fn(&service{logger: this.logger, db: txDB})
	})
}

func (this service) RunMigrations(models []interface{}) {
	if err := this.db.AutoMigrate(models...); err != nil {
		this.logger.Fatal(
			"running migration",
			"error", err,
		)
	}
}

func connect(
	logger logger.Logger,
	user, password, host, port, database string,
) *gorm.DB {
	dsn := fmt.Sprintf(
		"postgres://%s:%s@%s:%s/%s",
		user,
		password,
		host,
		port,
		database,
	)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		logger.Fatal(
			"connecting to postgres",
			"error", err,
		)
	}

	return db
}
